import json

import numpy as np
import pytest
import soundfile as sf

from server import audio_quality, rosvot
from server.storage import Cancelled


@pytest.fixture
def setup(tmp_path, monkeypatch):
    model_dir = tmp_path / 'quality-models'
    model_dir.mkdir()
    (model_dir / 'models.json').write_text('{}')
    (model_dir / 'voice-check.json').write_text(json.dumps({'abstain': False}))
    np.savez(model_dir / 'rhythm.npz', beats=np.arange(20) * .5, downbeats=np.arange(5) * 2.)
    times = np.arange(0., 2., .01)
    np.savez(model_dir / 'vocals-fcpe.npz', time=times, f0=np.full(200, 220.), activation=np.full(200, .9))
    audio = .1 * np.sin(2 * np.pi * 220 * np.arange(32000) / 16000)
    for name in ('analysis.wav', 'stem-vocals.wav'):
        sf.write(tmp_path / name, audio, 16000)
    monkeypatch.setattr(audio_quality, 'run_quality_models', lambda *args: model_dir)
    monkeypatch.setattr(audio_quality, 'infer_accompaniment_chords', lambda *args: [])
    source = {'id': 'a' * 32, 'tempo': 120, 'measures': 1, 'timeSignature': [4, 4], 'chords': [],
              'source': {'kind': 'audio', 'engine': 'test', 'warnings': []},
              'originalAudio': {'duration': 2, 'tempo': 120, 'offsetSeconds': 0},
              'parts': [{'id': 'vocals', 'name': 'vocals', 'role': 'lead', 'notes': [{'id': 'old', 'midi': 57, 'start': 0, 'duration': 4, 'velocity': .8}]}]}
    request = {'decoder': 'rosvot', 'lead_identity': 'off', 'verification': 'sampled'}
    return tmp_path, source, request


def run(setup):
    directory, source, request = setup
    return audio_quality.improve_project(directory, source, request, {'vocals': directory / 'stem-vocals.wav'}, {})


@pytest.mark.parametrize('lead_state', ['absent', 'unused', 'selected'])
def test_full_verification_follows_actual_vocal_input_without_claiming_identity(setup, monkeypatch, lead_state):
    from server import voice_verification
    directory, _, request = setup
    request.update(decoder='phoneme', verification='full')
    from server import phoneme
    monkeypatch.setattr(phoneme, 'infer_phoneme', lambda *args, **kwargs: {'events': [
        {'source_start_seconds': .1, 'source_end_seconds': .8, 'midi_pitch': 60}]})
    if lead_state != 'absent':
        (directory / 'stem-lead.wav').write_bytes(b'not the selected waveform')
        lead_models = directory / 'lead-identity/lead-models'
        lead_models.mkdir(parents=True)
        (lead_models / 'vocals-fcpe.npz').write_bytes(b'not the selected contour')
    if lead_state == 'selected':
        import shutil
        shutil.copyfile(directory / 'stem-vocals.wav', directory / 'stem-lead.wav')
        shutil.copyfile(directory / 'quality-models/vocals-fcpe.npz', lead_models / 'vocals-fcpe.npz')
        request['lead_identity'] = 'auto'
        monkeypatch.setattr(audio_quality, 'refine_vocal_identity', lambda *args: {
            'available': True, 'accepted': True, 'leadContour': str(lead_models / 'vocals-fcpe.npz'),
            'leadVerification': {'abstain': False}})
    def verify(job, audio, contour, status):
        assert audio == directory / ('stem-lead.wav' if lead_state == 'selected' else 'stem-vocals.wav')
        expected = 'lead-identity/lead-models/vocals-fcpe.npz' if lead_state == 'selected' else 'quality-models/vocals-fcpe.npz'
        assert contour == directory / expected
        return {'processedSeconds': 2, 'durationSeconds': 2, 'jointVoicedSeconds': 2,
                'within50CentsOnJointVoiced': 1, 'over6SemitonesOnJointVoiced': 0,
                'uncertaintyIntervals': [], 'unvoicedOrLowEvidenceSeconds': 0}
    monkeypatch.setattr(voice_verification, 'run_dense_voice_verification', verify)
    result = run(setup)
    quality = result['source']['analysis']['quality']
    assert quality['verificationStatus'] == 'complete'
    assert quality['vocals.leadIdentityAccepted'] is (lead_state == 'selected')
    expected_source = 'separated_lead' if lead_state == 'selected' else 'separated_vocals'
    assert quality['vocals.pitchEvidenceSource'] == expected_source
    evidence = json.loads((directory / 'quality-evidence.json').read_text())
    assert evidence['denseVoiceAudit']['inputSource'] == expected_source


def test_learned_notes_pass_through_joint_score_and_retain_baseline(setup, monkeypatch):
    monkeypatch.setattr(rosvot, 'infer_rosvot', lambda *args, **kwargs: {'events': [
        {'source_start_seconds': .02, 'source_end_seconds': .22, 'midi_pitch': 60},
        {'source_start_seconds': .27, 'source_end_seconds': .47, 'midi_pitch': 62},
        {'source_start_seconds': .47, 'source_end_seconds': .8, 'midi_pitch': None},
    ]})
    result = run(setup)
    assert [note['midi'] for note in result['parts'][0]['notes']] == [60, 62]
    assert all('confidence' not in note for note in result['parts'][0]['notes'])
    assert result['source']['analysis']['quality']['decoderProfile'] == 'rosvot'
    assert setup[1]['parts'][0]['notes'][0]['midi'] == 57
    saved = json.loads((setup[0] / 'quality-evidence.json').read_text())
    assert saved['parts']['vocals']['acousticAlternativeEvents']
    assert saved['parts']['vocals']['scoreRhythm']['noAttackDeduplication']


def test_sung_eighths_use_readable_score_timing_while_acoustic_events_remain_available(setup, monkeypatch):
    from server import phoneme
    setup[2]['decoder'] = 'phoneme'
    events = [{'source_start_seconds': a, 'source_end_seconds': b, 'midi_pitch': pitch}
              for a, b, pitch in [(.07, .28, 60), (.32, .53, 62), (.57, .78, 64), (.82, 1.03, 65)]]
    monkeypatch.setattr(phoneme, 'infer_phoneme', lambda *args, **kwargs: {'events': events})
    result = run(setup)
    notes = result['parts'][0]['notes']
    assert [(n['start'], n['duration']) for n in notes] == [(0., .5), (.5, .5), (1., .5), (1.5, .5)]
    saved = json.loads((setup[0] / 'quality-evidence.json').read_text())['parts']['vocals']
    assert saved['learnedVocalNotes']['events'] == events
    assert saved['scoreRhythm']['maximumOnsetShiftSeconds'] <= .11


def test_acoustic_pipeline_joins_short_same_pitch_dropouts_without_new_syllables(setup, monkeypatch):
    setup[2]['decoder'] = 'acoustic'
    events = [[.3, .87, 57, .96], [.90, .93, 57, .97], [.95, .96, 57, .33]]
    monkeypatch.setattr(audio_quality, 'decode_selected_contour', lambda *args: (events, {}))
    result = run(setup)
    assert [n['midi'] for n in result['parts'][0]['notes']] == [57]
    saved = json.loads((setup[0] / 'quality-evidence.json').read_text())['parts']['vocals']
    assert saved['fcpeAlternativeEvents'] == events
    assert saved['fragmentCleanup']['inputEvents'] == 3
    assert saved['fragmentCleanup']['outputEvents'] == 1


def test_model_failure_is_explicit_and_retains_acoustic_fallback(setup, monkeypatch):
    def fail(*args, **kwargs):
        raise RuntimeError('missing learned weights')
    monkeypatch.setattr(rosvot, 'infer_rosvot', fail)
    result = run(setup)
    assert result['parts'][0]['notes']
    quality = result['source']['analysis']['quality']
    assert quality['decoderRequested'] == 'rosvot' and quality['decoderProfile'] == 'acoustic'
    assert any('已回退' in item for item in result['source']['warnings'])


def test_cancel_is_not_swallowed_as_model_fallback(setup, monkeypatch):
    def cancel(*args, **kwargs):
        raise Cancelled()
    monkeypatch.setattr(rosvot, 'infer_rosvot', cancel)
    with pytest.raises(Cancelled):
        run(setup)


@pytest.mark.parametrize('events', [[], [
    {'source_start_seconds': 0., 'source_end_seconds': 2., 'midi_pitch': None},
], [
    {'source_start_seconds': 3., 'source_end_seconds': 4., 'midi_pitch': 60},
]])
def test_empty_learned_result_keeps_nonempty_fallback_and_model_evidence(setup, monkeypatch, events):
    monkeypatch.setattr(rosvot, 'infer_rosvot', lambda *args, **kwargs: {'events': events})
    result = run(setup)
    assert result['parts'][0]['notes']
    assert result['source']['analysis']['quality']['decoderProfile'] == 'acoustic'
    evidence = json.loads((setup[0] / 'quality-evidence.json').read_text())['parts']['vocals']
    assert evidence['learnedVocalNotes']['events'] == events
    assert evidence['decoderUsed'] == 'acoustic_fallback'
    assert 'learnedVocalError' in evidence


@pytest.mark.parametrize('profile', ['standard', 'acoustic', 'rosvot'])
@pytest.mark.parametrize('pitches', [(60, 60), (60, 62)])
def test_all_monophonic_decoders_preserve_colliding_attacks(setup, monkeypatch, profile, pitches):
    setup[2]['decoder'] = profile
    np.savez(setup[0] / 'quality-models/rhythm.npz', beats=np.arange(20.), downbeats=np.arange(5) * 4.)
    events = [[.94, 1.01, pitches[0], .9], [1.02, 1.09, pitches[1], .9]]
    monkeypatch.setattr(audio_quality, 'decode_selected_contour', lambda *args: (events, {}))
    def fail(*args, **kwargs):
        raise RuntimeError('missing learned weights')
    monkeypatch.setattr(rosvot, 'infer_rosvot', fail)
    result = run(setup)
    notes = result['parts'][0]['notes']
    assert [note['midi'] for note in notes] == list(pitches)
    assert notes[0]['start'] < notes[1]['start']
    assert all(note['duration'] > 0 for note in notes)
    evidence = json.loads((setup[0] / 'quality-evidence.json').read_text())['parts']['vocals']
    assert evidence['scoreRhythm']['noAttackDeduplication']
    assert evidence['scoreRhythm']['maximumOnsetShiftSeconds'] <= .11


def test_fallback_provenance_does_not_claim_an_abstained_acoustic_decoder(setup, monkeypatch):
    (setup[0] / 'quality-models/voice-check.json').write_text('{"abstain":true}')
    monkeypatch.setattr(rosvot, 'infer_rosvot', lambda *args, **kwargs: {'events': []})
    result = run(setup)
    quality = result['source']['analysis']['quality']
    assert quality['decoderProfile'] == 'baseline_fallback'
    assert quality['decoderVersion'] == 'not_applicable'
    assert [n['midi'] for n in result['parts'][0]['notes']] == [57]


@pytest.mark.parametrize('other_part', [False, True])
def test_learned_vocals_can_rescue_a_basic_pitch_miss(setup, monkeypatch, other_part):
    source = setup[1]
    source['parts'] = ([{**source['parts'][0], 'id': 'other', 'role': 'instrument'}] if other_part else [])
    monkeypatch.setattr(rosvot, 'infer_rosvot', lambda *args, **kwargs: {'events': [
        {'source_start_seconds': .1, 'source_end_seconds': .8, 'midi_pitch': 60},
    ]})
    result = run(setup)
    assert result['parts'][0]['id'] == 'vocals'
    assert [n['midi'] for n in result['parts'][0]['notes']] == [60]
    assert not any(part['id'] == 'vocals' for part in source['parts'])
    assert ('rawProjectUrl' in result['source']['analysis']) == other_part
    evidence = json.loads((setup[0] / 'quality-evidence.json').read_text())['parts']['vocals']
    assert evidence['rescueAccepted']


def test_empty_rescue_creates_no_phantom_vocal_part(setup, monkeypatch):
    setup[1]['parts'] = []
    monkeypatch.setattr(rosvot, 'infer_rosvot', lambda *args, **kwargs: {'events': []})
    result = run(setup)
    assert result['parts'] == []
    evidence = json.loads((setup[0] / 'quality-evidence.json').read_text())['parts']['vocals']
    assert not evidence['rescueAccepted']


def test_cancel_after_inference_precedes_empty_output_fallback(setup, monkeypatch):
    cancelled = False
    class Status:
        def update(self, *args):
            pass

        def check_cancelled(self):
            if cancelled:
                raise Cancelled()
    def infer(*args, **kwargs):
        nonlocal cancelled
        cancelled = True
        return {'events': []}
    monkeypatch.setattr(rosvot, 'infer_rosvot', infer)
    with pytest.raises(Cancelled):
        audio_quality.improve_project(setup[0], setup[1], setup[2],
                                      {'vocals': setup[0] / 'stem-vocals.wav'}, {}, Status())


def test_phoneme_model_uses_matching_waveform_and_keeps_its_native_boundaries(setup, monkeypatch):
    from server import phoneme, vocal_alignment
    setup[2]['decoder'] = 'phoneme'
    # A rejected/cached lead file must not silently override the chosen vocals.
    sf.write(setup[0] / 'stem-lead.wav', np.zeros(32000), 16000)
    def infer(audio_path, output, *, contour_path, **kwargs):
        assert audio_path == setup[0] / 'stem-vocals.wav'
        assert contour_path == setup[0] / 'quality-models/vocals-fcpe.npz'
        return {'events': [
            {'source_start_seconds': .17, 'source_end_seconds': .53, 'midi_pitch': 60},
            {'source_start_seconds': .57, 'source_end_seconds': .91, 'midi_pitch': 60},
        ]}
    def unexpected_alignment(*args):
        raise AssertionError('Phoneme model already supplies native singing boundaries')
    monkeypatch.setattr(phoneme, 'infer_phoneme', infer)
    monkeypatch.setattr(vocal_alignment, 'align_vocal_notes', unexpected_alignment)
    result = run(setup)
    notes = result['parts'][0]['notes']
    assert [note['midi'] for note in notes] == [60, 60]
    assert all('confidence' not in note for note in notes)
    quality = result['source']['analysis']['quality']
    assert quality['decoderProfile'] == 'phoneme'
    # Native performance boundaries are kept below; notation is a separate
    # metrical representation and must not inherit the old 25ms restriction.
    assert quality['vocalRhythmMaxOnsetShiftSeconds'] <= .11


def test_phoneme_empty_result_preserves_acoustic_fallback(setup, monkeypatch):
    from server import phoneme
    setup[2]['decoder'] = 'phoneme'
    monkeypatch.setattr(phoneme, 'infer_phoneme', lambda *args, **kwargs: {'events': []})
    result = run(setup)
    assert result['parts'][0]['notes']
    assert result['source']['analysis']['quality']['decoderProfile'] == 'acoustic'

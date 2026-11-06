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

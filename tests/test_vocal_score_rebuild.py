import copy
import json

import numpy as np
import pytest
import soundfile as sf

from server.vocal_score_rebuild import rebuild_vocal_rhythm


@pytest.fixture
def cached_score(tmp_path):
    job_id = 'a' * 32
    directory = tmp_path / job_id
    directory.mkdir()
    grid = {'bpm': 120, 'offsetSeconds': 0}
    events = [[.01, .17, 60, .9], [.19, .22, 60, .9], [.26, .48, 62, .9],
              [.52, .74, 64, .9], [.76, .99, 65, .9]]
    vocal = {'decoderUsed': 'acoustic_fallback', 'eventSourceBeforeLearnedModel': 'acoustic',
             'independentVerification': {'available': True, 'abstain': False},
             'fcpeAlternativeEvents': events, 'scoreRhythm': {'version': 'vocal-score-bounded-timing-1'}}
    source = f'/api/audio/{job_id}'

    def part(part_id, role, notes):
        return dict(id=part_id, name=part_id, shortName=part_id, instrument=part_id, color='#000',
                    role=role, clef='treble', program=0, notes=notes, muted=False, solo=False,
                    volume=.8, stemUrl=f'{source}/stem-{part_id}.wav')

    def note(midi, start, duration):
        return dict(id=f'{midi}:{start}', midi=midi, start=start, duration=duration, velocity=.8)

    project = {
        'version': 1, 'id': job_id, 'title': 'Cached vocal', 'composer': '', 'key': 'C',
        'createdAt': '', 'updatedAt': '', 'tempo': 120, 'timeSignature': [4, 4], 'measures': 1,
        'originalAudio': {'url': f'{source}/original.wav', 'duration': 3, 'tempo': 120, 'offsetSeconds': 0},
        'source': {'kind': 'audio', 'warnings': ['prior warning'], 'analysis': {
            'rhythm': grid, 'transforms': ['prior transform'], 'rawProjectUrl': f'/api/projects/{job_id}/raw',
            'quality': {'vocals.notes': 5, 'vocalRhythmVersion': 'vocal-score-bounded-timing-1'}}},
        'chords': [{'symbol': 'C', 'start': 0, 'duration': 2, 'pitches': [60, 64, 67]}],
        'parts': [part('vocals', 'lead', [note(p, s * 2, (e - s) * 2) for s, e, p, _ in events]),
                  part('piano', 'instrument', [note(72, 0, 2)])],
    }
    files = {
        'project.json': project, 'raw-project.json': project,
        'status.json': {'id': job_id, 'status': 'complete'},
        'analysis-evidence.json': {'mode': 'separate', 'analyzedDurationSeconds': 2},
        'quality-evidence.json': {'grid': grid, 'parts': {'vocals': vocal, 'piano': {'preserved': True}}},
    }
    for name, value in files.items():
        (directory / name).write_text(json.dumps(value))
    models = directory / 'quality-models'
    models.mkdir()
    sr = 16000
    wave = .2 * np.sin(2 * np.pi * 261.63 * np.arange(3 * sr) / sr)
    sf.write(directory / 'original.wav', wave, sr)
    sf.write(directory / 'stem-vocals.wav', wave[:2 * sr], sr)
    (models / 'inputs.json').write_text(json.dumps({'vocals': str(directory / 'stem-vocals.wav')}))
    times = np.arange(200) / 100
    np.savez(models / 'vocals-fcpe.npz', time=times, f0=np.full(len(times), 261.63), activation=np.ones(len(times)))
    return directory, project, events


def test_cached_acoustic_fallback_repairs_eighths_and_retains_source(cached_score):
    directory, project, events = cached_score
    before = {p: p.read_bytes() for p in directory.rglob('*') if p.is_file()}

    result, audit = rebuild_vocal_rhythm(directory)

    assert [(n['midi'], n['start'], n['duration']) for n in result['parts'][0]['notes']] == [
        (60, 0, .5), (62, .5, .5), (64, 1, .5), (65, 1.5, .5),
    ]
    voice = audit['parts']['vocals']
    assert voice['fcpeAlternativeEvents'] == events
    assert voice['fragmentCleanup']['edits'][0]['kind'] == 'same_pitch_dropout'
    assert voice['scoreRhythm']['maximumOffsetShiftSeconds'] > .025
    assert audit['modelRerun'] is False and audit['analyzedDurationSeconds'] == 2
    assert audit['parts']['piano'] == {'preserved': True}
    assert result['parts'][1] == project['parts'][1] and result['chords'] == project['chords']
    assert result['parts'][0]['stemUrl'] == project['parts'][0]['stemUrl']
    assert result['originalAudio'] == project['originalAudio'] and result['id'] != project['id']
    analysis = result['source']['analysis']
    assert analysis['rawProjectUrl'] == project['source']['analysis']['rawProjectUrl']
    assert analysis['quality']['modelEvidenceUrl'] == f"/api/projects/{result['id']}/evidence"
    assert {p: p.read_bytes() for p in directory.rglob('*') if p.is_file()} == before


def test_missing_fcpe_cache_is_rejected(cached_score):
    directory, _, _ = cached_score
    (directory / 'quality-models/vocals-fcpe.npz').unlink()

    with pytest.raises(FileNotFoundError, match='音高'):
        rebuild_vocal_rhythm(directory)


def test_learned_rebuild_uses_aligned_events_without_removing_short_reattack(cached_score):
    directory, _, events = cached_score
    path = directory / 'quality-evidence.json'
    audit = json.loads(path.read_text())
    voice = audit['parts']['vocals']
    voice['decoderUsed'] = 'rosvot'
    voice['alignedVocalEvents'] = [dict(source_start_seconds=s, source_end_seconds=e, midi_pitch=p)
                                   for s, e, p, _ in events]
    voice['learnedVocalNotes'] = {'events': [{**event, 'midi_pitch': 71} for event in voice['alignedVocalEvents']]}
    path.write_text(json.dumps(audit))
    (directory / 'quality-models/vocals-fcpe.npz').unlink()

    result, rebuilt = rebuild_vocal_rhythm(directory)

    assert [note['midi'] for note in result['parts'][0]['notes']] == [60, 60, 62, 64, 65]
    assert all('confidence' not in note for note in result['parts'][0]['notes'])
    assert rebuilt['cachedVocalSource']['events'] == 'alignedVocalEvents'
    assert 'fragmentCleanup' not in rebuilt['parts']['vocals']


def test_rejects_contour_input_from_another_job(cached_score):
    directory, _, _ = cached_score
    manifest = directory / 'quality-models/inputs.json'
    manifest.write_text(json.dumps({'vocals': str(directory.parent / ('b' * 32) / 'stem-vocals.wav')}))

    with pytest.raises(ValueError, match='输入记录'):
        rebuild_vocal_rhythm(directory)


def test_rejects_symlinked_contour(cached_score):
    directory, _, _ = cached_score
    contour = directory / 'quality-models/vocals-fcpe.npz'
    renamed = contour.with_name('renamed.npz')
    contour.rename(renamed)
    contour.symlink_to(renamed)

    with pytest.raises(ValueError, match='符号链接'):
        rebuild_vocal_rhythm(directory)


def test_cached_vocal_rebuild_is_available_and_discoverable_via_api(cached_score, monkeypatch):
    from fastapi.testclient import TestClient
    from server import config
    from server.app import create_app
    directory, source, _ = cached_score
    monkeypatch.setattr(config, 'engine_health', lambda: {})
    with TestClient(create_app(directory.parent)) as client:
        response = client.post(f'/api/projects/{directory.name}/score-rhythm')
        assert response.status_code == 200, response.text
        result = response.json()
        assert result['parts'][1] == source['parts'][1]
        assert client.get(f'/api/jobs/{result["id"]}').json()['project'] == result
        assert any(p['id'] == result['id'] for p in client.get('/api/projects').json()['projects'])
    request = json.loads((directory.parent / result['id'] / 'request.json').read_text())
    assert request['mode'] == 'separate' and request['max_seconds'] == 2


def test_legacy_learned_job_rearranges_its_own_cached_events(cached_score):
    from fastapi.testclient import TestClient
    from server.app import create_app

    source, original, _ = cached_score
    learned = source.parent / ('b' * 32)
    learned.mkdir()
    project = copy.deepcopy(original)
    project['id'] = learned.name
    project['tempo'] = 100  # Rehearsal tempo can differ from the source grid.
    analysis = project['source']['analysis']
    analysis['rawProjectUrl'] = f'/api/projects/{learned.name}/raw'
    analysis['quality'].update(decoderProfile='phoneme', decoderVersion='old', nativeEventsJobId=source.name,
                               modelEvidenceUrl=f'/api/projects/{learned.name}/evidence')
    events = [dict(source_start_seconds=.01, source_end_seconds=.23, midi_pitch=72),
              dict(source_start_seconds=.27, source_end_seconds=.49, midi_pitch=74)]
    files = {
        'project.json': project, 'raw-project.json': original,
        'status.json': {'id': learned.name, 'status': 'complete', 'project': project},
        'request.json': {'id': learned.name, 'mode': 'vocal-rebuild', 'action': 'vocal-rebuild',
                         'source_job_id': source.name, 'max_seconds': 2, 'decoder': 'phoneme'},
        'quality-evidence.json': {'vocalRebuildFromJob': source.name,
                                  'vocalInput': {'selectedStem': str(source / 'stem-vocals.wav')},
                                  'parts': {'vocals': {'decoderUsed': 'phoneme', 'alignedVocalEvents': events}}},
    }
    for name, value in files.items():
        (learned / name).write_text(json.dumps(value))

    with TestClient(create_app(source.parent)) as client:
        response = client.post(f'/api/projects/{learned.name}/score-rhythm')
        assert response.status_code == 200, response.text
        result = response.json()
        assert [n['midi'] for n in result['parts'][0]['notes']] == [72, 74]
        assert result['parts'][1:] == original['parts'][1:] and result['chords'] == original['chords']
        assert result['tempo'] == 100 and result['originalAudio'] == original['originalAudio']
        assert result['source']['analysis']['quality']['nativeEventsJobId'] == learned.name
        derived = source.parent / result['id']
        audit = json.loads((derived / 'quality-evidence.json').read_text())
        assert audit['modelRerun'] is False and audit['sourceProjectId'] == learned.name
        assert json.loads((derived / 'request.json').read_text())['max_seconds'] == 2

import copy
import importlib.util
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from server.multi import parts_from_multi_events
from server.polyphonic_score import quantize_polyphonic_events
from server.storage import atomic_json, read_json


@pytest.mark.parametrize('bpm', [20, 30, 60, 120, 240, 300])
@pytest.mark.parametrize('offset', [0, -.173])
def test_polyphonic_bound_preserves_attacks_overlaps_and_full_pitch_range(bpm, offset):
    events = [[.01 + i * .012, .08 + i * .012, 60, .8] for i in range(10)]
    events += [[.04, .06, 0, .7], [.04, .06, 127, .7], [.04, .8, 64, .7], [.04, .4, 67, .7]]
    notes, audit = quantize_polyphonic_events(events, {'bpm': bpm, 'offsetSeconds': offset}, 1., 'p')
    assert len(notes) == len(events)
    assert audit['maximumOnsetShiftSeconds'] <= .025 + 1e-7
    assert audit['maximumOffsetShiftSeconds'] <= .025 + 1e-7
    repeated = [n for n in notes if n['midi'] == 60]
    assert all(a['start'] < b['start'] for a, b in zip(repeated, repeated[1:]))
    assert repeated[0]['start'] + repeated[0]['duration'] > repeated[1]['start']
    assert all(n['duration'] > 0 and 'confidence' not in n for n in notes)
    assert {0, 127} <= {n['midi'] for n in notes}


def test_exact_simultaneous_notes_and_fast_drums_are_not_deduplicated():
    events = [[.01, .04, 36, .8], [.02, .05, 36, .8], [.02, .05, 36, .8], [.03, .06, 38, .8]]
    notes, _ = quantize_polyphonic_events(events, {'bpm': 120, 'offsetSeconds': 0}, 1, 'drums', percussion=True)
    assert len(notes) == 4
    assert notes[0]['start'] < notes[1]['start'] == notes[2]['start']


def test_one_short_note_does_not_dequantize_the_same_pitch_elsewhere():
    events = [[.011, .012, 60, .8], [2.011, 2.511, 60, .8], [3.011, 3.511, 60, .8]]
    notes, audit = quantize_polyphonic_events(events, {'bpm': 120, 'offsetSeconds': 0}, 4, 'p')
    assert [(n['start'], n['duration']) for n in notes[1:]] == [(4, 1), (6, 1)]
    assert audit['fineGridEvents'] == 1


def test_drum_decoder_offsets_do_not_create_micro_notes_or_force_fine_onsets():
    events = [[t, t + .01, 36, .8] for t in (.011, .511, 1.011)]
    notes, audit = quantize_polyphonic_events(events, {'bpm': 120, 'offsetSeconds': 0}, 2, 'drums', percussion=True)
    assert [(n['start'], n['duration']) for n in notes] == [(0, 1), (1, 1), (2, 1)]
    assert audit['maximumOnsetShiftSeconds'] <= .025
    assert audit['fineGridEvents'] == 0
    assert audit['offsetTimingToleranceSeconds'] is None


def test_refinement_expands_across_a_local_collision_without_moving_distant_notes():
    events = [[t, t + .01, 60, .8] for t in (.101, .102, .103, .104)]
    events += [[1.011, 1.511, 60, .8]]
    notes, audit = quantize_polyphonic_events(events, {'bpm': 120, 'offsetSeconds': 0}, 2, 'p')
    assert all(a['start'] < b['start'] for a, b in zip(notes, notes[1:]))
    assert notes[-1]['start'] == 2 and notes[-1]['duration'] == 1
    assert audit['maximumOnsetShiftSeconds'] <= .025


@pytest.mark.parametrize('event', [[0, .1, 128, .7], [0, 0, 60, .7], [float('nan'), 1, 60, .7], [-1, 1, 60, .7]])
def test_invalid_polyphonic_input_is_explicit(event):
    with pytest.raises(ValueError):
        quantize_polyphonic_events([event], {'bpm': 120, 'offsetSeconds': 0}, 1, 'p')


def test_analysis_cutoff_clips_offsets_and_audits_outside_events():
    notes, audit = quantize_polyphonic_events([[.9, 2, 60, .7], [1, 2, 64, .7]], {'bpm': 120, 'offsetSeconds': 0}, 1, 'p')
    assert len(notes) == 1 and audit['outsideAnalysisEvents'] == 1
    assert audit['clippedOffsetEvents'] == 1
    assert (notes[0]['start'] + notes[0]['duration']) / 2 == pytest.approx(1)


def events():
    return [{'start': .011, 'end': .041, 'midi': 60, 'program': program, 'isDrum': False}
            for program in (0, 2, 40, 41, 42)]


def test_decoded_classes_stay_separate_without_fabricated_confidence_or_stems():
    parts, audit = parts_from_multi_events(events(), {'bpm': 120, 'offsetSeconds': 0}, 1)
    assert {p['program'] for p in parts} == {0, 2, 40, 41, 42}
    assert len(parts) == 5
    assert audit['outputNotes'] == 5
    assert audit['claimsIndividualPerformerIdentity'] is False
    assert {p['clef'] for p in parts} == {'treble', 'alto', 'bass'}
    assert all('stemUrl' not in p and 'confidence' not in p['notes'][0] for p in parts)


@pytest.mark.parametrize('positive_phase', [False, True])
def test_multi_quality_uses_native_events_not_a_previously_lossy_score(tmp_path, monkeypatch, positive_phase):
    import server.audio_quality as module
    sf.write(tmp_path / 'analysis.wav', np.zeros(16000), 16000)
    models = tmp_path / 'quality-models'
    models.mkdir()
    atomic_json(models / 'models.json', {})
    np.savez(models / 'rhythm.npz', beats=[], downbeats=[])
    monkeypatch.setattr(module, 'run_quality_models', lambda *args: models)
    if positive_phase:
        monkeypatch.setattr(module, 'fit_beat_grid', lambda *args: {'bpm': 120., 'offsetSeconds': .04,
                            'beatTimesSeconds': [], 'downbeatTimesSeconds': [], 'method': 'test', 'confidence': .8})
    project = {'id': 'multi-test', 'tempo': 120, 'measures': 1, 'parts': [],
               'source': {'warnings': []}, 'originalAudio': {'tempo': 120, 'offsetSeconds': 0}}
    before = copy.deepcopy(project)
    result = module.improve_project(tmp_path, project, {'mode': 'multi', 'tempo': 120}, {}, {'multi': {'events': events()}})
    assert project == before
    assert len(result['parts']) == 5
    assert result['source']['analysis']['quality']['stage'] == 'multitrack_musical_score'
    evidence = read_json(tmp_path / 'quality-evidence.json')
    assert evidence['multiInstrument']['scoreConversion']['outputNotes'] == 5
    assert evidence['claimsMusicalCorrectness'] is False
    if positive_phase:
        assert result['originalAudio']['offsetSeconds'] == pytest.approx(-1.96)
        assert max(p['scoreRhythm']['maximumOnsetShiftSeconds'] for p in evidence['parts'].values()) == pytest.approx(.029)


def test_cached_renotation_builds_a_separate_project_without_mutating_saved_analysis(tmp_path):
    spec = importlib.util.spec_from_file_location('renotate', Path(__file__).parents[1] / 'scripts/renotate-multi.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    project = {'id': 'saved', 'tempo': 120, 'measures': 1, 'timeSignature': [4, 4],
               'parts': [], 'source': {'warnings': []}, 'originalAudio': {'offsetSeconds': 0}}
    atomic_json(tmp_path / 'project.json', project)
    atomic_json(tmp_path / 'multi-events.json', {'events': events()})
    atomic_json(tmp_path / 'analysis-evidence.json', {'analyzedDurationSeconds': 1})
    before = {p.name: p.read_bytes() for p in tmp_path.iterdir()}
    repaired, audit = module.rebuild(tmp_path)
    assert repaired['id'] != project['id'] and audit['sourceProjectId'] == 'saved'
    assert sum(len(p['notes']) for p in repaired['parts']) == len(events())
    assert repaired['originalAudio']['offsetSeconds'] == project['originalAudio']['offsetSeconds']
    assert repaired['originalAudio']['tempo'] == repaired['tempo']
    assert audit['modelRerun'] is False
    assert {p.name: p.read_bytes() for p in tmp_path.iterdir()} == before

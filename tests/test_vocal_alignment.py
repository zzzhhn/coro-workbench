import copy

import numpy as np
import pytest

from server.vocal_alignment import align_vocal_notes


def event(start, end, pitch):
    return {'source_start_seconds': start, 'source_end_seconds': end, 'midi_pitch': pitch, 'rest': pitch is None}


def evidence(pitch_spans, attacks=(), duration=3.):
    times = np.arange(.005, duration, .01)
    f0, activation, attack = (np.zeros(len(times)) for _ in range(3))
    for start, end, pitch in pitch_spans:
        selected = (times >= start) & (times < end)
        f0[selected] = 440 * 2 ** ((pitch - 69) / 12)
        activation[selected] = .9
    for second in attacks:
        attack[np.argmin(abs(times - second))] = 1.
    return times, f0, activation, {'attack': attack, 'rms': np.ones(len(times)) * .1, 'rms_floor': .001}


def test_word_onset_moves_to_supported_pitched_vowel_without_global_delay():
    notes = [event(0, .42, None), event(.42, 1., 60), event(1., 2., None)]
    before = copy.deepcopy(notes)
    result, details = align_vocal_notes(notes, *evidence([(.5, 1.08, 60)]))
    assert result[1]['source_start_seconds'] == pytest.approx(.5)
    assert result[1]['source_end_seconds'] == pytest.approx(1.08)
    assert details['referenceUsed'] is False and details['globalDelaySeconds'] == 0
    assert notes == before and len(result) == len(notes)


def test_same_pitch_words_need_an_independent_attack_and_are_never_merged():
    notes = [event(0, .5, 60), event(.5, .75, 60), event(.75, 1.5, 60)]
    result, _ = align_vocal_notes(notes, *evidence([(0, 1.5, 60)], attacks=(.55, .79)))
    assert len(result) == 3
    assert result[1]['source_start_seconds'] == pytest.approx(.545, abs=.011)
    assert result[2]['source_start_seconds'] == pytest.approx(.785, abs=.011)
    result, details = align_vocal_notes(notes, *evidence([(0, 1.5, 60)]))
    assert result == notes and details['boundaryEdits'] == []


def test_fast_supported_notes_cannot_be_swallowed_by_neighbor_alignment():
    notes = [event(0, .5, 60), event(.5, .57, 62), event(.57, 1.2, 64)]
    result, _ = align_vocal_notes(notes, *evidence([(0, .54, 60), (.54, .61, 62), (.61, 1.2, 64)]))
    assert [n['midi_pitch'] for n in result] == [60, 62, 64]
    assert all(n['source_end_seconds'] > n['source_start_seconds'] for n in result)
    assert all(a['source_end_seconds'] == b['source_start_seconds'] for a, b in zip(result, result[1:]))


def test_pitch_track_disagreement_does_not_fabricate_a_supported_onset():
    notes = [event(0, .5, None), event(.5, 1.5, 65)]
    result, details = align_vocal_notes(notes, *evidence([(.6, 1.5, 60)]))
    assert result == notes and details['boundaryEdits'] == []


def test_real_breath_is_not_shortened_into_an_articulation_gap():
    notes = [event(0, .8, 60), event(.8, 1.2, None), event(1.2, 2., 62)]
    result, _ = align_vocal_notes(notes, *evidence([(0, .96, 60), (1.13, 2., 62)]))
    assert result[1]['source_end_seconds'] - result[1]['source_start_seconds'] >= .3 - 1e-7


def test_invalid_or_overlapping_model_events_rejected():
    with pytest.raises(ValueError):
        align_vocal_notes([event(0, 1., 60), event(.8, 2., 62)], *evidence([(0, 2, 60)]))


def test_relative_clip_time_and_absolute_source_time_move_by_the_same_delta():
    notes = [dict(event(10., 10.42, None), start_seconds=0., end_seconds=.42),
             dict(event(10.42, 11., 60), start_seconds=.42, end_seconds=1.)]
    times, f0, activation, features = evidence([(.5, 1., 60)])
    result, _ = align_vocal_notes(notes, times + 10., f0, activation, features)
    assert result[1]['source_start_seconds'] == pytest.approx(10.5)
    assert result[1]['start_seconds'] == pytest.approx(.5)
    assert result[0]['end_seconds'] == pytest.approx(.5)

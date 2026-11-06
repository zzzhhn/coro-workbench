import copy

import numpy as np
import pytest

from server.vocal_score import clean_vocal_fragments, quantize_vocal_rhythm


def evidence(events, attacks=(), wavering=()):
    times = np.arange(.005, 4., .01)
    f0 = np.zeros(len(times))
    attack = np.zeros(len(times))
    for start, end, pitch, _ in events:
        mask = (times >= start) & (times < end)
        values = np.full(mask.sum(), pitch, dtype=float)
        if (start, end) in wavering:
            values += np.linspace(-.48, .48, mask.sum())
        f0[mask] = 440 * 2 ** ((values - 69) / 12)
    for start in attacks:
        attack[np.argmin(abs(times - start))] = 1.
    return times, f0, {"attack": attack}


def test_short_same_pitch_dropout_fragments_become_one_note_not_extra_syllables():
    events = [[.3, .87, 66, .96], [.90, .93, 66, .97], [.95, .96, 66, .33], [1., 1.4, 59, .98]]
    before = copy.deepcopy(events)
    notes, info = clean_vocal_fragments(events, *evidence(events))
    assert [(n[0], n[1], n[2]) for n in notes] == [(.3, .96, 66), (1., 1.4, 59)]
    assert len(info["edits"]) == 2 and events == before


def test_same_pitch_short_reattacks_and_true_breath_are_not_joined():
    events = [[.2, .6, 63, .9], [.6, .67, 63, .9], [.67, .82, 63, .9], [1., 1.4, 63, .9]]
    notes, _ = clean_vocal_fragments(events, *evidence(events, attacks=(.6, .67)))
    assert notes == events


def test_rapid_semitone_return_needs_platform_or_attack_to_be_a_distinct_note():
    events = [[.2, .8, 60, .9], [.8, .89, 61, .9], [.89, 1.4, 60, .9]]
    notes, info = clean_vocal_fragments(events, *evidence(events, wavering=((.8, .89),)))
    assert len(notes) == 1 and info["edits"][0]["kind"] == "unstable_neighbor_return"
    steady, _ = clean_vocal_fragments(events, *evidence(events))
    assert steady == events
    attacked, _ = clean_vocal_fragments(events, *evidence(events, attacks=(.8,), wavering=((.8, .89),)))
    assert attacked == events


def test_isolated_ten_ms_pitch_spike_does_not_get_a_full_32nd_note():
    events = [[.2, .21, 80, .99], [1., 1.5, 60, .9]]
    notes, info = clean_vocal_fragments(events, *evidence(events))
    assert notes == events[1:] and info["edits"][0]["kind"] == "unsupported_micro_island"


def test_joint_rhythm_notates_regular_attacks_without_articulation_rest_confetti():
    events = [[.012, .215, 60, .9], [.27, .46, 62, .9], [.52, .705, 64, .9], [.763, .965, 65, .9]]
    before = copy.deepcopy(events)
    notes, info = quantize_vocal_rhythm(events, {"bpm": 120, "offsetSeconds": 0}, 2)
    assert [(n["start"], n["duration"]) for n in notes] == [(0., .5), (.5, .5), (1., .5), (1.5, .5)]
    assert [n["midi"] for n in notes] == [60, 62, 64, 65]
    assert events == before and info["noAttackDeduplication"]


def test_real_fast_notes_survive_in_order_without_by_start_deduplication():
    events = [[.5 + i * .0625, .5 + (i + 1) * .0625, 60 + i % 5, .9] for i in range(8)]
    notes, info = quantize_vocal_rhythm(events, {"bpm": 120, "offsetSeconds": 0}, 2)
    assert len(notes) == 8 and [n["midi"] for n in notes] == [int(n[2]) for n in events]
    assert all(abs(n["duration"] - .125) < 1e-7 for n in notes)
    assert info["maximumOnsetShiftSeconds"] < .025


def test_preserves_breath_and_handles_negative_audio_phase_without_changing_pitch():
    events = [[.4, .9, 60, .8], [1.3, 1.8, 62, .8]]
    notes, info = quantize_vocal_rhythm(events, {"bpm": 90, "offsetSeconds": -.2}, 3, preserve_confidence=False)
    assert (notes[1]["start"] - notes[0]["start"] - notes[0]["duration"]) * 60 / 90 >= .30
    assert all("confidence" not in n for n in notes)
    assert len(info["boundaryChanges"]) == len(events)


@pytest.mark.parametrize("events", [[[0, 1, 60]], [[0, float('nan'), 60, .8]], [[0, 1, 128, .8]], [[0, 1, 60, .8], [.5, 1.5, 62, .8]]])
def test_bad_or_polyphonic_events_are_rejected(events):
    with pytest.raises(ValueError):
        quantize_vocal_rhythm(events, {"bpm": 120, "offsetSeconds": 0}, 3)

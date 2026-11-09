import copy
import json
from pathlib import Path

import numpy as np
import pytest

from server.vocal_score import _select_joint_rhythm_path, clean_vocal_fragments, quantize_vocal_rhythm


def test_slow_sung_phrase_does_not_turn_small_lateness_into_tied_32nds():
    spb = 60 / 65
    events = [[i * spb + .12, (i + 1) * spb + .12, 60 + i, .9] for i in range(4)]
    notes, audit = quantize_vocal_rhythm(events, {'bpm': 65, 'offsetSeconds': 0}, 5)
    assert [(n['start'], n['duration']) for n in notes] == [(i, 1) for i in range(4)]
    assert audit['boundaryChanges'][0]['sourceStartSeconds'] == .12


def test_short_vowels_get_the_same_metrical_onset_tolerance_as_long_vowels():
    events = [[i * .5 + .1, i * .5 + .24, 60 + i, .9] for i in range(4)]
    notes, _ = quantize_vocal_rhythm(events, {'bpm': 60, 'offsetSeconds': 0}, 3)
    assert [(n['start'], n['duration']) for n in notes] == [(i * .5, .25) for i in range(4)]


def test_delayed_sixteenth_attacks_can_reach_their_coarse_grid():
    events = [[.10, .28, 60, .9], [.30, .48, 62, .9], [.55, .73, 60, .9], [.80, .98, 64, .9]]
    before = copy.deepcopy(events)
    notes, audit = quantize_vocal_rhythm(events, {'bpm': 65, 'offsetSeconds': 0}, 2)
    assert [(note['start'], note['duration']) for note in notes] == [(i / 4, .25) for i in range(4)]
    assert [note['midi'] for note in notes] == [row[2] for row in before]
    assert events == before
    assert [(item['sourceStartSeconds'], item['sourceEndSeconds']) for item in audit['boundaryChanges']] == [
        tuple(row[:2]) for row in before
    ]
    assert max(audit['maximumOnsetShiftSeconds'], audit['maximumOffsetShiftSeconds']) <= .16


@pytest.mark.parametrize('beats', [
    [0., .5, 1., 1.125, 1.5, 2.],  # isolated 32nd inside a slower phrase
    [0., .5, 1., 1.125, 1.25, 1.75, 2.5],  # two adjacent 32nds
    [.5 + i / 8 for i in range(9)],  # dense run of eight 32nds
])
def test_true_32nd_attacks_keep_their_relative_spacing_at_a_slow_tempo(beats):
    spb = 60 / 65
    events = [[a * spb, b * spb, 60 + i % 3, .9] for i, (a, b) in enumerate(zip(beats, beats[1:]))]
    notes, _ = quantize_vocal_rhythm(events, {'bpm': 65, 'offsetSeconds': 0}, 3)
    assert [note['midi'] for note in notes] == [row[2] for row in events]
    for index, (start, end) in enumerate(zip(beats, beats[1:])):
        if end - start == .125:
            assert (notes[index]['start'], notes[index]['duration']) == (start, .125)


def test_strict_acoustic_mode_retains_a_64th_run():
    spb = .5
    beats = [.5 + i / 16 for i in range(9)]
    events = [[a * spb, b * spb, 60 + i % 3, .9] for i, (a, b) in enumerate(zip(beats, beats[1:]))]
    notes, audit = quantize_vocal_rhythm(events, {'bpm': 120, 'offsetSeconds': 0}, 2,
                                        timing_tolerance_seconds=.01)
    assert [(n['start'], n['duration'], n['midi']) for n in notes] == [
        (a, b-a, row[2]) for a, b, row in zip(beats, beats[1:], events)
    ]
    assert max(audit['maximumOnsetShiftSeconds'], audit['maximumOffsetShiftSeconds']) <= .01


def test_rest_quantization_does_not_compress_a_syllable_to_one_third_its_body():
    events = [[.4, .725, 62, .8], [1.05, 1.31, 64, .8], [1.525, 1.72, 66, .8]]
    notes, _ = quantize_vocal_rhythm(events, {'bpm': 60, 'offsetSeconds': 0}, 3)
    assert notes[0]['duration'] >= .25
    assert notes[1]['start'] - notes[0]['start'] - notes[0]['duration'] >= .18


@pytest.mark.parametrize('bpm', [30, 60, 90, 120, 180, 240])
def test_bounded_notation_keeps_every_attack_within_25ms(bpm):
    events = [[.94, 1.01, 60, .9], [1.02, 1.09, 60, .8],
              [1.09, 1.27, 62, .9], [1.53, 1.97, 64, .8]]
    notes, audit = quantize_vocal_rhythm(events, {'bpm': bpm, 'offsetSeconds': 0}, 3.,
                                        timing_tolerance_seconds=.025)
    assert [note['midi'] for note in notes] == [60, 60, 62, 64]
    assert audit['maximumOnsetShiftSeconds'] <= .025 + 1e-6
    assert audit['maximumOffsetShiftSeconds'] <= .025 + 1e-6
    assert all(note['duration'] > 0 for note in notes)
    assert all(a['start'] + a['duration'] <= b['start'] + 1e-6 for a, b in zip(notes, notes[1:]))
    assert (notes[-1]['start'] - notes[-2]['start'] - notes[-2]['duration']) * 60 / bpm >= .18


def test_bounded_notation_does_not_pull_a_measured_attack_towards_a_distant_simple_beat():
    events = [[.07, .39, 60, .9], [.39, .83, 62, .9]]
    _, audit = quantize_vocal_rhythm(events, {'bpm': 120, 'offsetSeconds': 0}, 2.,
                                    timing_tolerance_seconds=.025)
    assert audit['maximumOnsetShiftSeconds'] <= .025
    assert audit['sharedTouchingBoundaries'] == 1


@pytest.mark.parametrize('limit', [float('nan'), 0, -.1, .2])
def test_invalid_timing_bound_is_rejected(limit):
    with pytest.raises(ValueError, match='Timing tolerance'):
        quantize_vocal_rhythm([[0, 1, 60, .9]], {'bpm': 120, 'offsetSeconds': 0}, 2,
                              timing_tolerance_seconds=limit)


def test_bounded_notation_does_not_hide_a_grid_that_starts_after_the_audio():
    with pytest.raises(ValueError, match='timing bound'):
        quantize_vocal_rhythm([[0, .5, 60, .9]], {'bpm': 120, 'offsetSeconds': .2}, 2,
                              timing_tolerance_seconds=.025)


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


def test_two_short_repeated_notes_are_not_a_fragment_of_a_sustained_note():
    events = [[.94, 1.01, 60, .9], [1.02, 1.09, 60, .9]]
    notes, _ = clean_vocal_fragments(events, *evidence(events))
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


def test_touching_short_events_share_quantized_boundaries_without_losing_attacks():
    # Independent synthetic durations: an isolated short event previously made
    # the cost-only path insert a 1/64 rest despite a continuous input sequence.
    events = [[.199, .294, 60, .8], [.294, .568, 61, .8],
              [.568, .620, 62, .8], [.620, .711, 63, .8]]
    before = copy.deepcopy(events)
    notes, info = quantize_vocal_rhythm(events, {"bpm": 90, "offsetSeconds": 0}, 2)
    assert [note["midi"] for note in notes] == [60, 61, 62, 63]
    assert all(note["duration"] > 0 for note in notes)
    assert all(abs(left["start"] + left["duration"] - right["start"]) < 1e-7
               for left, right in zip(notes, notes[1:]))
    assert info["touchingBoundaries"] == info["sharedTouchingBoundaries"] == 3
    assert not info["touchingBoundaryFallback"] and info["unsharedTouchingBoundaries"] == []
    assert events == before


def test_limited_choice_fallback_breaks_only_unavoidable_touching_junctions():
    rows = [[0, .3, 60, .8], [.3, .6, 61, .8], [.6, .9, 62, .8]]
    # The first junction cannot meet with these bounded candidates. The second
    # still shares a boundary even though a second break has a lower music cost.
    options = [[(0., .5, 0.)], [(.625, 1., 0.), (.625, 1.125, 0.)],
               [(1., 1.5, 9.), (1.25, 1.5, 0.)]]
    selected = _select_joint_rhythm_path(rows, options, .5)
    assert selected == [(0., .5, 0.), (.625, 1., 0.), (1., 1.5, 9.)]
    assert len(selected) == len(rows)


def test_infeasible_collision_path_is_explicit_instead_of_dropping_an_event():
    rows = [[0, .3, 60, .8], [.3, .6, 61, .8]]
    with pytest.raises(ValueError, match="No collision-free"):
        _select_joint_rhythm_path(rows, [[(0., 1., 0.)], [(.5, .75, 0.)]], .5)


def test_touching_boundary_policy_keeps_real_breaths_and_repeated_fast_attacks():
    events = [[.2, .3, 60, .8], [.3, .4, 60, .8], [.4, .5, 61, .8],
              [.8, .9, 60, .8], [.9, 1., 60, .8]]
    notes, info = quantize_vocal_rhythm(events, {"bpm": 120, "offsetSeconds": 0}, 2)
    assert [note["midi"] for note in notes] == [60, 60, 61, 60, 60]
    for index in [0, 1, 3]:
        assert notes[index]["start"] + notes[index]["duration"] == notes[index + 1]["start"]
    assert (notes[3]["start"] - notes[2]["start"] - notes[2]["duration"]) * .5 >= .18
    assert not info["touchingBoundaryFallback"]


def test_local_saved_aligned_songs_do_not_gain_rests_at_touching_boundaries():
    # Private recordings/results are deliberately not distributed. When local
    # evidence exists, cover the actual cited passages without embedding song
    # arrays in the public test suite or invoking any inference model.
    root = Path(__file__).resolve().parents[1]
    manifest = root / "evidence/phase7/four-aligned-vocal-songs.json"
    if not manifest.is_file():
        pytest.skip("optional private four-song aligned evidence is not installed")
    for case in json.loads(manifest.read_text())["results"]:
        project = json.loads((root / "data" / case["jobId"] / "project.json").read_text())
        evidence = json.loads((root / "data" / case["jobId"] / "quality-evidence.json").read_text())
        rows = [[event["source_start_seconds"], event["source_end_seconds"], event["midi_pitch"], .75]
                for event in evidence["alignedVocalEvents"] if event["midi_pitch"] is not None]
        duration = max(event["source_end_seconds"] for event in evidence["alignedVocalEvents"])
        notes, info = quantize_vocal_rhythm(rows, evidence["grid"], duration, preserve_confidence=False)
        assert [note["midi"] for note in notes] == [row[2] for row in rows]
        assert not info["touchingBoundaryFallback"], case["filename"]
        assert info["sharedTouchingBoundaries"] == info["touchingBoundaries"]
        assert all(note["duration"] > 0 for note in notes)
        assert len(notes) == len(next(part for part in project["parts"] if part["id"] == "vocals")["notes"])
        for index in range(1, len(rows)):
            if rows[index][0] - rows[index - 1][1] <= 1e-7:
                assert abs(notes[index]["start"] - notes[index - 1]["start"] - notes[index - 1]["duration"]) < 1e-6


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

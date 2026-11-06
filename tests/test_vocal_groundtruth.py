"""Hand-computable metric truth and independent exhaustive small-note checks."""
import itertools
import importlib.util
from pathlib import Path

import numpy as np
import pytest

from server.vocal_groundtruth import align_f0_tracks, evaluate_f0_track, evaluate_note_annotators, f0_metrics, match_notes, note_metrics, resample_f0_track


def test_hand_counted_voiced_unvoiced_octave_and_false_alarm():
    result = f0_metrics([220, 220, 0, 0], [220, 440, 220, 0])
    assert result["overallAccuracy"] == .5
    assert result["voicingRecall"] == 1
    assert result["voicingFalseAlarm"] == .5
    assert result["rawPitchAccuracy"] == .5
    assert result["rawChromaAccuracy"] == 1
    assert result["counts"]["overallCorrect"] == 2


def test_octave_errors_are_chroma_correct_but_pitch_wrong():
    result = f0_metrics([220, 440], [440, 220])
    assert result["rawPitchAccuracy"] == result["overallAccuracy"] == 0
    assert result["rawChromaAccuracy"] == 1
    assert result["voicingFalseAlarm"] is None


def test_raw_pitch_retains_unvoiced_hypothesis_while_overall_requires_voicing():
    negative = f0_metrics([220, 440], [-220, -440])
    explicit = f0_metrics([220, 440], [220, 440], estimated_voicing=[False, False])
    assert negative == explicit
    assert negative["rawPitchAccuracy"] == 1
    assert negative["voicingRecall"] == negative["overallAccuracy"] == 0


def test_silence_does_not_manufacture_pitch_success():
    result = f0_metrics([0, 0], [0, 0])
    assert result["overallAccuracy"] == 1
    assert result["voicingFalseAlarm"] == 0
    assert result["voicingRecall"] is result["rawPitchAccuracy"] is result["rawChromaAccuracy"] is None
    false_pitch = f0_metrics([0, 0], [220, 220])
    assert false_pitch["overallAccuracy"] == 0
    assert false_pitch["voicingFalseAlarm"] == 1


def test_missing_estimates_count_as_misses():
    result = f0_metrics([220, 220], [np.nan, 0])
    assert result["rawPitchAccuracy"] == result["voicingRecall"] == result["overallAccuracy"] == 0


def test_cents_threshold_and_chroma_wrap():
    frequency = 220 * 2 ** (np.array([49., 51., 1200 + 49., 1200 + 51.]) / 1200)
    result = f0_metrics([220] * 4, frequency)
    assert result["rawPitchAccuracy"] == .25
    assert result["rawChromaAccuracy"] == .5


def test_log_pitch_interpolation_stays_inside_continuous_voiced_run():
    pitch, voice = resample_f0_track([0, .01], [220, 440], [.005])
    assert pitch[0] == pytest.approx(np.sqrt(220 * 440))
    assert voice[0]


def test_reference_zero_gap_is_never_filled_or_swept_by_interpolation():
    query = np.array([.01, .015, .02, .024, .025, .03])
    pitch, voice = resample_f0_track([0, .01, .02, .03, .04], [220, 220, 0, 440, 440], query)
    np.testing.assert_array_equal(voice, [True, False, False, False, True, True])
    np.testing.assert_array_equal(pitch[1:4], [0, 0, 0])
    assert pitch[0] == pytest.approx(220)
    assert pitch[-1] == pytest.approx(440)


def test_missing_time_gap_and_outside_track_extent_abstain():
    query = [-.02, 0, .01, .02, .2, .49, .5, .51, .53]
    pitch, voice = resample_f0_track([0, .01, .5, .51], [220, 220, 440, 440], query)
    np.testing.assert_array_equal(voice, [False, True, True, False, False, False, True, True, False])
    assert np.all(pitch[[0, 3, 4, 5, 8]] == 0)


def test_known_100ms_offset_is_penalized_and_never_optimized_away():
    times = np.arange(0, 1.01, .1)
    f0 = np.where((times >= .2) & (times < .6), 220., 0.)
    result = evaluate_f0_track(times, f0, times + .1, f0, duration_seconds=1.)
    assert result["voicingRecall"] == pytest.approx(.75)
    assert result["rawPitchAccuracy"] == pytest.approx(.75)
    assert result["voicingFalseAlarm"] == pytest.approx(1 / 6)
    assert result["overallAccuracy"] == pytest.approx(.8)
    assert result["timingAdjustmentSeconds"] == 0


def test_identical_tracks_on_canonical_grid_match_without_reading_audio():
    times = np.arange(0., 1., .0058)
    f0 = np.where((times >= .1) & (times < .8), 230., 0.)
    result = evaluate_f0_track(times, f0, times, f0, duration_seconds=1.)
    assert result["overallAccuracy"] == result["rawPitchAccuracy"] == 1
    assert result["gridFrames"] == 100


def test_note_offset_mode_separates_correct_onset_from_wrong_duration():
    reference = [[.1, 1.1, 220]]
    estimate = [[.14, 1.5, 220]]
    assert note_metrics(reference, estimate, require_offset=False)["f1"] == 1
    assert note_metrics(reference, estimate, require_offset=True)["f1"] == 0


def test_short_note_offset_uses_50ms_floor_and_long_note_20percent():
    assert len(match_notes([[.1, .2, 220]], [[.1, .25, 220]])) == 1
    assert len(match_notes([[.1, .2, 220]], [[.1, .2502, 220]])) == 0
    assert len(match_notes([[.1, 1.1, 220]], [[.1, 1.3, 220]])) == 1


def test_note_pitch_is_not_octave_invariant_and_threshold_is_inclusive():
    assert not match_notes([[.1, 1., 220]], [[.1, 1., 440]])
    assert match_notes([[.1, 1., 220]], [[.15, 1., 220 * 2 ** (50 / 1200)]]) == [(0, 0)]


def test_duplicate_predictions_cannot_match_same_reference_twice():
    result = note_metrics([[.1, 1., 220]], [[.1, 1., 220], [.1, 1., 220]])
    assert result["matchedNotes"] == 1
    assert result["precision"] == .5
    assert result["recall"] == 1
    assert result["f1"] == pytest.approx(2 / 3)


def test_augmenting_path_recovers_match_that_greedy_would_lose():
    reference = [[.1, 1., 220], [.18, 1., 220]]
    estimate = [[.14, 1., 220], [.06, 1., 220]]
    assert match_notes(reference, estimate) == [(0, 1), (1, 0)]


def test_matching_count_agrees_with_independent_exhaustive_enumeration():
    random = np.random.default_rng(3320)
    for _ in range(30):
        ref = np.column_stack((random.uniform(.1, .4, 4), np.full(4, 1.), random.choice([220., 440.], 4)))
        est = np.column_stack((random.uniform(.1, .4, 4), np.full(4, 1.), random.choice([220., 440.], 4)))
        best = 0
        for allocation in itertools.product(range(-1, 4), repeat=4):
            used = [index for index in allocation if index >= 0]
            if len(set(used)) != len(used):
                continue
            valid = all(index < 0 or (round(abs(ref[i, 0] - est[index, 0]), 4) <= .05 and ref[i, 2] == est[index, 2]) for i, index in enumerate(allocation))
            if valid:
                best = max(best, len(used))
        assert len(match_notes(ref, est)) == best


def test_both_human_note_versions_are_preserved_as_distinct_scores():
    estimate = [[.1, 1., 220]]
    result = evaluate_note_annotators(estimate, [[.1, .5, 220], [.5, 1., 220]], estimate)
    assert result["A1"]["onsetOffsetPitch"]["f1"] == 1
    assert result["A2"]["onsetOffsetPitch"]["f1"] == 0
    assert result["A2"]["onsetPitch"]["f1"] == pytest.approx(2 / 3)


def test_empty_notes_and_invalid_inputs_are_explicit():
    assert note_metrics([], [])["f1"] is None
    assert note_metrics([[0, 1, 220]], [])["f1"] == 0
    with pytest.raises(ValueError):
        f0_metrics([], [])
    with pytest.raises(ValueError):
        f0_metrics([-220], [220])
    with pytest.raises(ValueError):
        resample_f0_track([0, 0], [220, 220], [0])
    with pytest.raises(ValueError):
        note_metrics([[1, 0, 220]], [])


def evaluator_module():
    path = Path(__file__).resolve().parents[1] / "scripts/evaluate-vocal-groundtruth.py"
    spec = importlib.util.spec_from_file_location("vocal_evaluator_split_guards", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_holdout_selection_comes_only_from_exact_predeclared32_ids():
    module = evaluator_module()
    ids = sorted(map(str, range(1, 41)))
    manifest = {"tracks": [{"id": value} for value in ids], "pilotIds": ids[:8]}
    protocol = {"evaluationSplit": "holdout", "evaluationIds": ids[8:], "excludedPilotIds": ids[:8]}
    assert module.select_evaluation_ids(manifest, protocol, "holdout") == ids[8:]
    assert module.select_evaluation_ids(manifest, {"pilotIds": ids[:8]}, "pilot") == ids[:8]
    for bad in (
        {**protocol, "evaluationIds": ids[8:-1]},
        {**protocol, "evaluationIds": ids[8:-1] + [ids[0]]},
        {**protocol, "evaluationIds": ids[8:-1] + [ids[8]]},
        {**protocol, "excludedPilotIds": []},
        {**protocol, "evaluationSplit": "pilot"},
    ):
        with pytest.raises(ValueError):
            module.select_evaluation_ids(manifest, bad, "holdout")


def test_holdout_output_cannot_overwrite_or_overlap_pilot():
    module = evaluator_module()
    root = Path(__file__).resolve().parents[1]
    good_output = root / "evidence/phase4/vocadito-holdout-evaluation.json"
    good_private = root / "data/phase4/vocadito-holdout"
    module.validate_split_outputs("holdout", good_output, good_private)
    with pytest.raises(ValueError):
        module.validate_split_outputs("holdout", root / "evidence/phase4/vocadito-evaluation-summary.json", good_private)
    for bad_private in (root / "data/phase4/vocadito-evaluation", root / "data/phase4/vocadito-pilot", root / "data/phase4", root / "data/phase4/vocadito-pilot/nested"):
        with pytest.raises(ValueError):
            module.validate_split_outputs("holdout", good_output, bad_private)

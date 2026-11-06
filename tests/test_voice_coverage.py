import numpy as np
from server.voice_coverage import summarize_coverage


def contour(count=200):
    return dict(time=np.arange(count) * .02, fcpeF0=np.full(count, 440.), crepeF0=np.full(count, 440.),
                activation=np.ones(count), periodicity=np.ones(count), audible=np.ones(count, dtype=bool))


def test_distinguishes_raw_missing_from_activation_rejection_and_disagreement():
    arrays = contour()
    arrays["fcpeF0"][10:30] = 0
    arrays["activation"][50:70] = 0
    arrays["fcpeF0"][90:110] = 220
    before = {key: value.copy() for key, value in arrays.items()}
    result = summarize_coverage(arrays, 4)
    assert [item["kind"] for item in result["intervals"]] == ["fcpe_missing", "fcpe_gated", "pitch_disagreement"]
    assert result["intervals"][0] == dict(kind="fcpe_missing", startSeconds=.2, endSeconds=.6,
                                           supportSeconds=.4, supportFraction=1.)
    assert result["totalsSeconds"] == {"fcpe_missing": .4, "fcpe_gated": .4, "pitch_disagreement": .4}
    assert result["groundTruthAvailable"] is False
    for key, value in arrays.items():
        np.testing.assert_array_equal(value, before[key])


def test_energy_and_independent_voicing_gates_prevent_silence_false_alarms():
    arrays = contour()
    arrays["fcpeF0"][:] = 0
    arrays["audible"][:100] = False
    arrays["periodicity"][100:] = .1
    result = summarize_coverage(arrays, 4)
    assert not result["intervals"]
    assert sum(result["totalsSeconds"].values()) == 0


def test_short_transients_are_counted_but_not_reported_as_sustained_checkpoints():
    arrays = contour()
    arrays["fcpeF0"][10:20] = 0
    arrays["fcpeF0"][100:110] = 0
    result = summarize_coverage(arrays, 4)
    assert result["totalsSeconds"]["fcpe_missing"] == .4
    assert not result["intervals"]


def test_small_gaps_join_but_support_counts_only_real_frames():
    arrays = contour()
    arrays["fcpeF0"][10:20] = 0
    arrays["fcpeF0"][22:30] = 0
    item = summarize_coverage(arrays, 4)["intervals"][0]
    assert item["supportSeconds"] == .36
    assert item["supportFraction"] == .9


def test_long_gap_is_not_bridged_and_sparse_support_is_not_a_checkpoint():
    arrays = contour()
    arrays["fcpeF0"][10:20] = 0
    arrays["fcpeF0"][24:34] = 0
    arrays["fcpeF0"][70:170:3] = 0
    assert not summarize_coverage(arrays, 4)["intervals"]


def test_never_counts_beyond_recording_or_adds_an_extra_final_hop():
    arrays = contour()
    arrays["fcpeF0"][:] = 0
    result = summarize_coverage(arrays, 3.991)
    assert result["totalsSeconds"]["fcpe_missing"] == 3.991
    assert result["intervals"][0]["endSeconds"] == 3.991


def test_nonfinite_or_missing_crepe_is_not_positive_evidence():
    arrays = contour()
    arrays["fcpeF0"][:] = np.nan
    arrays["crepeF0"][:100] = np.nan
    arrays["periodicity"][100:] = np.nan
    assert not summarize_coverage(arrays, 4)["intervals"]


def test_overview_is_bounded_with_explicit_truncation():
    arrays = contour(30000)
    arrays["fcpeF0"][np.arange(30000) % 30 < 15] = 0
    result = summarize_coverage(arrays, 600)
    assert result["totalIntervals"] == 1000
    assert len(result["intervals"]) == 400
    assert result["truncated"]


def test_saved_thresholds_are_used_not_silently_replaced():
    arrays = contour()
    arrays["activation"][:] = .05
    assert not summarize_coverage(arrays, 4)["intervals"]
    assert summarize_coverage(arrays, 4, activation=.1)["totalsSeconds"]["fcpe_gated"] == 4

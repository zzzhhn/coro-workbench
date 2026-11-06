import numpy as np

from server.vocal_dp import duration_viterbi


def test_duration_decoder_preserves_sixty_ms_real_notes():
    truth = np.repeat([60, 62, 64, 62, 65, 64], 6)
    contour = truth + .15 * np.sin(np.arange(len(truth)) * .4)
    np.testing.assert_array_equal(duration_viterbi(contour), truth)


def test_duration_decoder_preserves_vibrato_as_one_pitch():
    contour = 60 + .58 * np.sin(np.arange(140) * .4)
    np.testing.assert_array_equal(duration_viterbi(contour), np.full(140, 60))


def test_duration_decoder_rejects_thirty_ms_octave_glitch_without_gap():
    contour = np.full(160, 60.)
    contour[75:78] = 72
    result = duration_viterbi(contour)
    np.testing.assert_array_equal(result, np.full(160, 60))


def test_short_island_kept_and_finite():
    np.testing.assert_array_equal(duration_viterbi(np.array([64.02, 64.08])), [64, 64])
    assert duration_viterbi(np.array([])).size == 0

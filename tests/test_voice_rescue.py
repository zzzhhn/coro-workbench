"""Analytic waveform truth, not copied from either model's output.

CREPE arrays below are declared verifier stubs so both correct and misleading
verifier hypotheses can be tested without running a neural model. pYIN and raw
waveform checks are exercised on the actual generated waveform.
"""
import numpy as np
import pytest

from server.voice_rescue import CONFIG, estimate_classical_pitch, merge_rescue_into_missing, rescue_missing_voice_pitch


def fixture_case(name, harmonics=(1., .5, .25), noise=0., gap_noise=False, silence=False, crepe_octave=False):
    sr, duration, pitch = 8000, 2., 220.
    samples = np.arange(round(duration * sr)) / sr
    times = np.arange(0., duration, .01)
    active_samples = (samples >= .1) & (samples < 1.9)
    envelope = np.clip((samples - .1) / .01, 0, 1) * np.clip((1.9 - samples) / .01, 0, 1)
    audio = sum(amplitude * np.sin(2 * np.pi * pitch * harmonic * samples) for harmonic, amplitude in enumerate(harmonics, 1))
    audio = .08 * audio * envelope * active_samples
    truth = np.where((times >= .1) & (times < 1.9), pitch, 0.)
    if not any(harmonics):
        truth[:] = 0
    random = np.random.default_rng(845173)
    if noise:
        audio += random.normal(0, noise, len(audio))
    if gap_noise:
        selected_samples = (samples >= .5) & (samples < 1.5)
        audio[selected_samples] = random.normal(0, .025, selected_samples.sum())
        truth[(times >= .5) & (times < 1.5)] = 0
    if silence:
        audio[:] = 0
        truth[:] = 0
    missing = (times >= .5) & (times < 1.5)
    fcpe = truth.copy()
    fcpe[missing] = 0
    crepe = np.where((times >= .1) & (times < 1.9), pitch, 0.)
    confidence = np.where(crepe > 0, .95, 0.)
    if crepe_octave:
        crepe[missing] *= 2
    if silence:
        crepe[:] = pitch
        confidence[:] = .95
    return {"name": name, "times": times, "fcpe": fcpe, "crepe": crepe, "confidence": confidence, "audio": audio.astype(np.float32), "sr": sr, "truth": truth, "missing": missing}


def fixture_cases():
    return [
        fixture_case("known-harmonic-pitch"),
        fixture_case("pitch-with-mild-noise", noise=.006),
        fixture_case("breath-noise-in-missing-gap", gap_noise=True),
        fixture_case("noise-only-with-confident-false-verifier", harmonics=(0.,), noise=.025, gap_noise=True),
        fixture_case("silence-with-confident-false-verifier", silence=True),
        fixture_case("missing-fundamental", harmonics=(0., 1., .7, .35)),
        fixture_case("octave-conflicting-verifier", crepe_octave=True),
        fixture_case("single-sine-ambiguous-harmonic-support", harmonics=(1.,)),
    ]


def run_fixture(case, classical=None):
    return rescue_missing_voice_pitch(case["times"], case["fcpe"], case["times"], case["crepe"], case["confidence"], case["audio"], case["sr"], classical_evidence=classical)


@pytest.fixture(scope="module")
def measured_cases():
    output = {}
    for case in fixture_cases():
        classical = estimate_classical_pitch(case["audio"], case["sr"])
        proposal, detail = run_fixture(case, classical)
        output[case["name"]] = (case, proposal, detail)
    return output


@pytest.mark.parametrize("name", ["known-harmonic-pitch", "pitch-with-mild-noise", "missing-fundamental"])
def test_known_waveform_pitch_is_rescued_without_neural_ground_truth(measured_cases, name):
    case, proposal, _ = measured_cases[name]
    target = case["missing"] & (case["truth"] > 0)
    accepted = proposal[target] > 0
    assert accepted.mean() >= .75
    assert np.max(abs(1200 * np.log2(proposal[target][accepted] / case["truth"][target][accepted]))) <= 25


@pytest.mark.parametrize("name", ["breath-noise-in-missing-gap", "noise-only-with-confident-false-verifier", "silence-with-confident-false-verifier", "octave-conflicting-verifier", "single-sine-ambiguous-harmonic-support"])
def test_false_or_ambiguous_support_abstains(measured_cases, name):
    _, proposal, detail = measured_cases[name]
    assert np.sum(proposal > 0) == 0
    assert detail["counts"]["accepted"] == 0


def test_existing_nonzero_fcpe_is_never_overwritten_even_on_octave_disagreement(measured_cases):
    case, proposal, _ = measured_cases["known-harmonic-pitch"]
    original = case["fcpe"].copy()
    original[10:30] = 440.
    before = original.copy()
    output = merge_rescue_into_missing(original, np.full(len(original), 220.))
    np.testing.assert_array_equal(original, before)
    np.testing.assert_array_equal(output[original > 0], original[original > 0])
    assert np.all(proposal[case["fcpe"] > 0] == 0)


def test_raw_waveform_octave_competitor_blocks_shared_wrong_octave():
    case = fixture_case("both-estimators-wrong-octave")
    fake = {"time": case["times"], "f0": np.full(len(case["times"]), 440.), "probability": np.ones(len(case["times"]))}
    case["crepe"][:] = 440.
    case["confidence"][:] = .99
    proposal, _ = run_fixture(case, fake)
    assert not np.any(proposal)


def test_missing_only_merge_and_input_contract():
    source = np.array([220., 0., np.nan, 440., 40.])
    result = merge_rescue_into_missing(source, np.array([110., 220., 330., 220., 55.]))
    np.testing.assert_array_equal(result, [220., 220., 330., 440., 40.])
    with pytest.raises(ValueError):
        merge_rescue_into_missing(source, np.zeros(2))
    case = fixture_case("invalid")
    with pytest.raises(ValueError):
        rescue_missing_voice_pitch(case["times"][::-1], case["fcpe"], case["times"], case["crepe"], case["confidence"], case["audio"], case["sr"])
    assert CONFIG.minimum_sustained_seconds == .10

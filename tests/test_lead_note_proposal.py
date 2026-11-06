"""Constructed acoustic truth; no parameters are selected on user heldouts."""
import numpy as np
import pytest

from server.lead_note_proposal import CONFIG, decode_lead_note_proposal, frame_acoustic_evidence


def synthesize(events, duration=3., sr=16000, vibrato=0., notch=None, dropout=None, glide=None, noise_gap=None):
    hop = .01
    times = np.arange(hop / 2, duration, hop)
    sample_times = np.arange(round(duration * sr)) / sr
    f0 = np.zeros(len(times))
    activation = np.zeros(len(times))
    instantaneous = np.zeros(len(sample_times))
    envelope = np.zeros(len(sample_times))
    for start, end, midi in events:
        selected = (times >= start) & (times < end)
        contour = midi + vibrato * np.sin(2 * np.pi * 5.5 * times[selected])
        f0[selected] = 440 * 2 ** ((contour - 69) / 12)
        activation[selected] = .92
        samples = (sample_times >= start) & (sample_times < end)
        instantaneous[samples] = 440 * 2 ** ((midi + vibrato * np.sin(2 * np.pi * 5.5 * sample_times[samples]) - 69) / 12)
        a = np.clip((sample_times[samples] - start) / .008, 0, 1)
        b = np.clip((end - sample_times[samples]) / .01, 0, 1)
        envelope[samples] = a * b
    if glide:
        start, end, first, last = glide
        selected = (times >= start) & (times < end)
        f0[selected] = 440 * 2 ** ((np.linspace(first, last, selected.sum()) - 69) / 12)
        activation[selected] = .92
        selected_samples = (sample_times >= start) & (sample_times < end)
        instantaneous[selected_samples] = 440 * 2 ** ((np.linspace(first, last, selected_samples.sum()) - 69) / 12)
    phase = np.cumsum(2 * np.pi * instantaneous / sr)
    audio = .12 * envelope * (np.sin(phase) + .35 * np.sin(2 * phase) + .15 * np.sin(3 * phase))
    if notch:
        center, width = notch
        audio *= 1 - .98 * np.exp(-((sample_times - center) / width) ** 4)
    if dropout:
        start, end = dropout
        selected = (times >= start) & (times < end)
        f0[selected] = 0
        activation[selected] = .001
    if noise_gap:
        start, end = noise_gap
        selected = (sample_times >= start) & (sample_times < end)
        audio[selected] = np.random.default_rng(1847).normal(0, .04, selected.sum())
        frames = (times >= start) & (times < end)
        f0[frames] = 0
        activation[frames] = .001
    return times, f0, activation, audio.astype(np.float32), sr


def synthetic_cases():
    return [
        {"name": "steady-vibrato", "truth": [[.2, 2.6, 60]], "data": synthesize([[.2, 2.6, 60]], vibrato=.70)},
        {"name": "stable-melody", "truth": [[.2, .7, 60], [.7, 1.2, 62], [1.2, 1.7, 64], [1.7, 2.5, 62]], "data": synthesize([[.2, .7, 60], [.7, 1.2, 62], [1.2, 1.7, 64], [1.7, 2.5, 62]], vibrato=.15)},
        {"name": "true-breath-gap", "truth": [[.2, 1.0, 60], [1.16, 2.5, 60]], "data": synthesize([[.2, 1.0, 60], [1.16, 2.5, 60]])},
        {"name": "same-pitch-reattack", "truth": [[.2, 1.2, 60], [1.2, 2.5, 60]], "data": synthesize([[.2, 2.5, 60]], notch=(1.17, .035))},
        {"name": "harmonic-model-dropout", "truth": [[.2, 2.5, 60]], "data": synthesize([[.2, 2.5, 60]], dropout=(1.0, 1.03))},
        {"name": "noisy-consonant-gap", "truth": [[.2, 1., 60], [1.03, 2.5, 60]], "data": synthesize([[.2, 2.5, 60]], noise_gap=(1., 1.03))},
        {"name": "one-semitone-short-note", "truth": [[.2, 1.0, 60], [1., 1.08, 61], [1.08, 2.5, 60]], "data": synthesize([[.2, 1.0, 60], [1., 1.08, 61], [1.08, 2.5, 60]])},
        {"name": "continuous-portamento", "truth": None, "data": synthesize([[.2, 2.5, 60]], glide=(.8, 1.4, 60, 67)), "floor": "No unique discrete note truth for a continuous slide; uncertainty must be explicit."},
        {"name": "inaudible-false-f0", "truth": [], "data": (np.arange(.005, 3., .01), np.full(300, 440.), np.full(300, .9), np.zeros(48000, np.float32), 16000)},
    ]


@pytest.mark.parametrize("profile", ["acoustic_segments", "metric_boundary"])
def test_stable_vibrato_does_not_become_chromatic_note_steps(profile):
    data = synthesize([[.2, 2.6, 60]], vibrato=.7)
    events, info = decode_lead_note_proposal(*data, profile=profile, bpm=120)
    assert len(events) == 1
    assert events[0][2] == 60
    assert abs(events[0][0] - .2) < .03
    assert abs(events[0][1] - 2.6) < .03
    assert info["referencePitchUsed"] is False


def test_large_thirty_ms_f0_glitch_does_not_create_an_octave_note():
    times, f0, strength, audio, sr = synthesize([[.2, 2.6, 60]])
    f0[(times >= 1) & (times < 1.03)] *= 2
    events, _ = decode_lead_note_proposal(times, f0, strength, audio, sr)
    assert len(events) == 1
    assert events[0][2] == 60


def test_melody_changes_kept_without_silence_and_count_explosion():
    truth = [[.2, .7, 60], [.7, 1.2, 62], [1.2, 1.7, 64], [1.7, 2.5, 62]]
    events, _ = decode_lead_note_proposal(*synthesize(truth, vibrato=.15))
    assert [event[2] for event in events] == [event[2] for event in truth]
    for actual, expected in zip(events, truth):
        assert abs(actual[0] - expected[0]) <= .04
        assert abs(actual[1] - expected[1]) <= .04


def test_preserves_silent_breath_but_fills_evidenced_harmonic_model_dropout():
    events, _ = decode_lead_note_proposal(*synthesize([[.2, 1., 60], [1.16, 2.5, 60]]))
    assert len(events) == 2
    assert events[1][0] - events[0][1] >= .12
    events, info = decode_lead_note_proposal(*synthesize([[.2, 2.5, 60]], dropout=(1., 1.03)))
    assert len(events) == 1
    assert info["filledModelDropouts"]


def test_acoustic_energy_valley_can_split_a_same_pitch_attack():
    data = synthesize([[.2, 2.5, 60]], notch=(1.17, .035))
    features = frame_acoustic_evidence(data[0], data[3], data[4])
    assert np.max(features["attack"][(data[0] > 1.1) & (data[0] < 1.3)]) > .45
    events, info = decode_lead_note_proposal(*data)
    assert len(events) == 2
    assert all(event[2] == 60 for event in events)
    assert abs(events[1][0] - 1.2) <= .07
    assert info["acousticReattackCandidates"] >= 1


def test_portamento_uncertainty_is_not_reported_as_confirmed_note_truth():
    events, info = decode_lead_note_proposal(*synthesize([[.2, 2.5, 60]], glide=(.8, 1.4, 60, 67)))
    assert info["glideUncertaintyIntervals"]
    assert events


def test_metric_path_keeps_count_order_and_bounded_acoustic_boundary_moves():
    data = synthesize([[.21, .71, 60], [.71, 1.21, 62], [1.34, 1.79, 64], [1.85, 2.55, 60]])
    raw, _ = decode_lead_note_proposal(*data)
    structured, info = decode_lead_note_proposal(*data, profile="metric_boundary", bpm=120, beat_offset_seconds=0.)
    assert len(raw) == len(structured)
    assert [event[2] for event in raw] == [event[2] for event in structured]
    for original, moved in zip(raw, structured):
        assert max(abs(original[0] - moved[0]), abs(original[1] - moved[1])) <= CONFIG.metric_boundary_limit_seconds + 1e-8
    assert all(left[1] <= right[0] + 1e-8 for left, right in zip(structured, structured[1:]))
    assert info["grid"]["noOnsetDeduplication"] is True


def test_silent_audio_does_not_produce_notes_from_confident_false_f0():
    times = np.arange(.005, 3., .01)
    events, _ = decode_lead_note_proposal(times, np.full(len(times), 440), np.ones(len(times)), np.zeros(48000), 16000)
    assert events == []


def test_no_mutation_invalid_inputs_and_unknown_profile():
    data = synthesize([[.2, 2.5, 60]])
    copies = [value.copy() if isinstance(value, np.ndarray) else value for value in data]
    decode_lead_note_proposal(*data)
    for before, after in zip(copies, data):
        np.testing.assert_array_equal(before, after)
    with pytest.raises(ValueError):
        decode_lead_note_proposal(*data, profile="guess")
    with pytest.raises(ValueError):
        decode_lead_note_proposal(data[0][::-1], *data[1:])
    with pytest.raises(ValueError):
        decode_lead_note_proposal(*data, profile="metric_boundary")

from __future__ import annotations

import numpy as np

from server.audio_quality import _upgrade_identity_evidence, merge_unsupported_retriggers, note_quality, piano_onset_consensus, remove_pedal_overlap
from server.rhythm import fit_beat_grid, quantize_on_grid
from server.vocal import decode_vocal_contour


def test_grid_recovers_phase_and_tempo_with_spurious_beats():
    rng = np.random.default_rng(74)
    beats = .31 + np.arange(160) * 60 / 105 + rng.normal(0, .004, 160)
    downbeats = beats[::4]
    beats = np.sort(np.r_[beats, 1.05, 7.37, 22.48])
    grid = fit_beat_grid(beats, downbeats, 103)
    assert abs(grid["bpm"] - 105) < .03
    assert abs((grid["offsetSeconds"] - .31) % (240 / grid["bpm"])) < .02 or abs((.31 - grid["offsetSeconds"]) % (240 / grid["bpm"])) < .02
    assert grid["offsetSeconds"] <= 0
    assert grid["beatInlierFraction"] > .95
    assert grid["beatResidualMedianSeconds"] < .01


def test_grid_respects_manual_bpm_and_sparse_fallback():
    grid = fit_beat_grid(np.arange(40) * .5 + .2, np.arange(10) * 2 + .2, 100, 120)
    assert grid["bpm"] == 120
    sparse = fit_beat_grid(np.array([0, .5]), np.array([]), 108)
    assert sparse["bpm"] == 108 and sparse["confidence"] == 0


def test_phase_mapping_preserves_audio_time_with_weak_start():
    grid = {"bpm": 120, "offsetSeconds": -1.7}
    events = [[.3, .8, 60, .8], [.8, 1.2, 62, .8]]
    notes = quantize_on_grid(events, grid, 5, "vocal", monophonic=True)
    assert notes[0]["start"] == 4
    assert abs(grid["offsetSeconds"] + notes[0]["start"] * .5 - .3) < 1e-8
    assert notes[0]["start"] + notes[0]["duration"] <= notes[1]["start"]
    assert len({n["id"] for n in notes}) == len(notes)


def test_slow_mono_grid_does_not_force_short_note_to_sixteenth():
    grid = {"bpm": 65, "offsetSeconds": 0}
    event = [[1, 1.09, 64, .9]]
    coarse = quantize_on_grid(event, grid, 5, "vocal", monophonic=True)
    finer = quantize_on_grid(event, grid, 5, "vocal", monophonic=True, quantum=.125)
    assert finer[0]["duration"] == .125
    assert finer[0]["duration"] < coarse[0]["duration"]


def test_vocal_decoder_is_monophonic_and_does_not_fill_silence():
    sr = 16000
    times = np.arange(300) * .01
    pitch = np.zeros(300)
    pitch[20:110] = 440 * 2 ** ((64 - 69) / 12) * (1 + .005 * np.sin(np.arange(90)))
    pitch[160:260] = 440 * 2 ** ((67 - 69) / 12)
    activation = np.where(pitch > 0, .95, .00001)
    audio = np.zeros(3 * sr)
    audio[int(.2 * sr):int(1.1 * sr)] = .2
    audio[int(1.6 * sr):int(2.6 * sr)] = .2
    events, details = decode_vocal_contour(times, pitch, activation, audio, sr)
    assert [n[2] for n in events] == [64, 67]
    assert events[0][1] < 1.2 and events[1][0] > 1.5
    assert details["polyphonicBackingPreservedInRawProject"]
    assert len(events) == 2


def test_pedal_proposal_keeps_all_attacks_and_pitch():
    notes = [[0, 3, 48, .8], [.5, 3, 52, .8], [.5, 3, 64, .8], [1, 3, 67, .8]]
    result, changed = remove_pedal_overlap(notes, [{"onset_time": 0, "offset_time": 3}])
    assert [(n[0], n[2]) for n in result] == [(n[0], n[2]) for n in notes]
    assert result[0][1] == .5 and result[2][1] == 1
    assert changed == 2
    assert notes[0][1] == 3


def test_piano_consensus_one_to_one_and_disagreements_preserved():
    baseline = [[0, 1, 60, .8], [1, 2, 62, .8], [2, 3, 65, .8]]
    other = [[.02, 1, 60, .7, .8], [.08, 1, 60, .7, .8], [1.05, 2, 62, .7, .8], [2, 3, 67, .7, .8]]
    agreed, evidence = piano_onset_consensus(other, baseline)
    assert len(agreed) == 2
    assert evidence["reviewCandidateCount"] == 3
    assert len(baseline) == 3 and len(other) == 4


def test_reattack_consolidation_preserves_actual_repeated_attack():
    declining = np.linspace(1, .1, 1000)
    events = [[0, .5, 60, .9], [.5, .9, 60, .4]]
    merged, evidence = merge_unsupported_retriggers(events, declining, 1000)
    assert len(merged) == 1 and evidence
    attack = declining.copy()
    attack[500:550] = 1
    separate, _ = merge_unsupported_retriggers(events, attack, 1000)
    assert len(separate) == 2


def test_mechanical_quality_not_accuracy_label():
    parts = [{"id": "v", "notes": [{"midi": 60, "start": 0, "duration": 1}, {"midi": 64, "start": .5, "duration": 1}]}]
    m = note_quality(parts)
    assert m["v.maxPolyphony"] == 2
    assert m["v.overlapBeats"] == .5
    assert "accuracy" not in m


def test_partial_identity_does_not_relabel_failed_interval_verified(tmp_path):
    result = {"accepted": False, "leadVerification": {"intervals": [{"startSeconds": 6, "durationSeconds": 3, "comparedFrames": 130, "over6Semitones": .02}, {"startSeconds": 20, "durationSeconds": 3, "comparedFrames": 100, "over6Semitones": .44}]}}
    updated = _upgrade_identity_evidence(result, tmp_path)
    assert updated["accepted"] is False
    assert updated["usablePartial"] is True
    assert updated["uncertaintyIntervals"][0]["startSeconds"] == 20
    assert updated["uncertaintyIntervals"][0]["endSeconds"] == 23
    assert "CREPE sampled lead contour" in updated["uncertaintyIntervals"][0]["alternatives"]


def test_identity_fully_failed_samples_remain_unusable(tmp_path):
    result = {"accepted": False, "leadVerification": {"intervals": [{"startSeconds": 0, "durationSeconds": 3, "comparedFrames": 100, "over6Semitones": .7}]}}
    updated = _upgrade_identity_evidence(result, tmp_path)
    assert updated["usablePartial"] is False


def test_kara_host_zero_backing_preserves_input(tmp_path, monkeypatch):
    import soundfile as sf
    import server.lead_separation as module
    model = tmp_path / "model.onnx"
    model.write_bytes(b"fake test model; no real inference")
    class Hash:
        def hexdigest(self):
            return module.KARA2_SHA256
    monkeypatch.setattr(module.hashlib, "sha256", lambda _: Hash())
    class Session:
        def __init__(self, *args, **kwargs):
            pass
        def run(self, names, inputs):
            assert inputs["input"].shape == (1, 4, 2048, 256)
            assert np.all(inputs["input"][:, :, :3] == 0)
            return [np.zeros_like(inputs["input"])]
    monkeypatch.setattr(module.ort, "InferenceSession", Session)
    t = np.arange(11025) / 44100
    waveform = np.column_stack([.2 * np.sin(440 * 2 * np.pi * t), .15 * np.sin(330 * 2 * np.pi * t)]).astype(np.float32)
    source = tmp_path / "vocals.wav"
    sf.write(source, waveform, 44100, subtype="FLOAT")
    report = module.separate_lead_backing(source, model, tmp_path / "out")
    lead, sr = sf.read(tmp_path / "out/lead.wav", dtype="float32")
    assert sr == 44100 and lead.shape == waveform.shape
    np.testing.assert_allclose(lead, waveform, atol=1e-7)
    assert report["compensatedReconstructionRmsError"] < 1e-7


def test_dense_uncertainty_merge_retains_different_reasons():
    from server.dense_voice_verify import merge_spans
    spans = [{"startSeconds": 1, "endSeconds": 2, "reason": "octave"}, {"startSeconds": 1.75, "endSeconds": 2.75, "reason": "octave"}, {"startSeconds": 3, "endSeconds": 4, "reason": "insufficient-periodicity"}]
    result = merge_spans(spans)
    assert result == [{"startSeconds": 1, "endSeconds": 2.75, "reason": "octave"}, {"startSeconds": 3, "endSeconds": 4, "reason": "insufficient-periodicity"}]

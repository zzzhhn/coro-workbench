from __future__ import annotations

import math

import numpy as np


def fit_beat_grid(beats: np.ndarray, downbeats: np.ndarray, fallback_bpm: float, requested_bpm: float | None = None) -> dict:
    """Fit one stable grid, rejecting isolated neural half-beats rather than stretching notes."""
    beats = np.asarray(beats, dtype=float)
    beats = np.unique(beats[np.isfinite(beats) & (beats >= 0)])
    downbeats = np.asarray(downbeats, dtype=float)
    downbeats = np.unique(downbeats[np.isfinite(downbeats) & (downbeats >= 0)])
    fallback = {"bpm": float(requested_bpm or fallback_bpm), "offsetSeconds": 0.0, "beatTimesSeconds": beats.tolist(), "downbeatTimesSeconds": downbeats.tolist(), "method": "constant-grid fallback; insufficient learned beat support", "confidence": 0.0, "beatResidualMedianSeconds": None, "beatInlierFraction": 0.0, "downbeatCoherence": 0.0, "timeSignature": [4, 4]}
    if len(beats) < 8:
        return fallback
    intervals = np.diff(beats)
    sensible = intervals[(intervals >= 0.20) & (intervals <= 2.0)]
    if len(sensible) < 5:
        return fallback
    initial = 60 / requested_bpm if requested_bpm else float(np.median(sensible))
    if requested_bpm:
        periods = np.array([initial])
    else:
        periods = np.linspace(initial * .96, initial * 1.04, 1401)
    phases = np.exp(2j * np.pi * beats[:, None] / periods[None, :]).mean(axis=0)
    chosen = int(np.argmax(np.abs(phases)))
    period = float(periods[chosen])
    phase = float((np.angle(phases[chosen]) % (2 * np.pi)) * period / (2 * np.pi))
    indices = np.rint((beats - phase) / period)
    residual = np.abs(beats - (phase + indices * period))
    inliers = residual < period * .15
    if inliers.sum() < 6:
        return fallback
    if not requested_bpm:
        for _ in range(3):
            period, phase = np.polyfit(indices[inliers], beats[inliers], 1)
            indices = np.rint((beats - phase) / period)
            residual = np.abs(beats - (phase + indices * period))
            inliers = residual < max(.06, period * .12)
    else:
        phase = float(np.median(beats[inliers] - indices[inliers] * period))
    if not 30 <= 60 / period <= 240:
        return fallback
    # A neural downbeat may be spuriously doubled. Vote modulo four actual beats instead.
    bar_phase = phase
    down_coherence = 0.0
    if len(downbeats) >= 3:
        z = np.exp(2j * np.pi * (downbeats - phase) / (4 * period)).mean()
        down_coherence = float(abs(z))
        down_index = round((np.angle(z) % (2 * np.pi)) * 4 / (2 * np.pi)) % 4
        bar_phase = phase + down_index * period
    bar_phase %= 4 * period
    # Preserve sound before the first downbeat by starting from a virtual preceding bar.
    offset = bar_phase - 4 * period if bar_phase > .04 else bar_phase
    confidence = float(np.mean(inliers) * np.exp(-np.median(residual[inliers]) / max(.01, period * .1)))
    return {"bpm": round(float(60 / period), 4), "offsetSeconds": round(float(offset), 6), "beatTimesSeconds": np.round(beats, 5).tolist(), "downbeatTimesSeconds": np.round(downbeats, 5).tolist(), "method": "Beat This! final0 + robust constant beat/downbeat phase fit", "confidence": round(confidence, 4), "beatResidualMedianSeconds": round(float(np.median(residual[inliers])), 5), "beatInlierFraction": round(float(np.mean(inliers)), 4), "downbeatCoherence": round(down_coherence, 4), "timeSignature": [4, 4]}


def quantize_on_grid(events: list, grid: dict, duration: float, part_id: str, monophonic: bool = False, preserve_confidence: bool = True, quantum: float = .25) -> list[dict]:
    bpm = grid["bpm"]
    offset = grid["offsetSeconds"]
    notes = {}
    for event in events:
        start, end, pitch, strength = event[:4]
        if not all(math.isfinite(float(v)) for v in (start, end, pitch, strength)) or pitch < 0 or pitch > 127:
            continue
        if end <= start or start >= duration:
            continue
        start_beat = max(0, round((float(start) - offset) * bpm / 60 / quantum) * quantum)
        end_beat = max(start_beat + quantum, round((min(float(end), duration) - offset) * bpm / 60 / quantum) * quantum)
        key = (start_beat, int(pitch))
        candidate = {"id": "", "midi": int(pitch), "start": round(start_beat, 6), "duration": round(end_beat - start_beat, 6), "velocity": round(float(np.clip(strength, .18, 1)), 4), "origin": "transcribed"}
        if preserve_confidence:
            candidate["confidence"] = round(float(np.clip(strength, 0, 1)), 4)
        if key not in notes or notes[key]["velocity"] < candidate["velocity"]:
            notes[key] = candidate
    result = sorted(notes.values(), key=lambda n: (n["start"], n["midi"]))
    if monophonic:
        by_start = {}
        for note in result:
            old = by_start.get(note["start"])
            if old is None or old["velocity"] < note["velocity"]:
                by_start[note["start"]] = note
        result = sorted(by_start.values(), key=lambda n: n["start"])
        for left, right in zip(result, result[1:]):
            left["duration"] = min(left["duration"], right["start"] - left["start"])
    else:
        previous = {}
        for note in result:
            left = previous.get(note["midi"])
            if left and left["start"] + left["duration"] > note["start"]:
                left["duration"] = note["start"] - left["start"]
            previous[note["midi"]] = note
    for index, note in enumerate(result, 1):
        note["id"] = f"{part_id}-q{index}"
    return result

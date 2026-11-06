from __future__ import annotations

import numpy as np
from scipy.ndimage import median_filter


def _runs(values: np.ndarray) -> list[tuple[int, int, int]]:
    if not len(values):
        return []
    indices = np.r_[0, np.flatnonzero(values[1:] != values[:-1]) + 1, len(values)]
    return [(int(a), int(b), int(values[a])) for a, b in zip(indices, indices[1:])]


def decode_vocal_contour(times: np.ndarray, f0: np.ndarray, activation: np.ndarray, audio: np.ndarray, sr: int, role: str = "vocals") -> tuple[list, dict]:
    """Produce a dominant-line proposal; polyphonic backing vocals stay in the raw companion."""
    times = np.asarray(times, dtype=float)
    f0 = np.asarray(f0, dtype=float)
    activation = np.asarray(activation, dtype=float)
    if len(times) < 2:
        return [], {"method": "FCPE", "voicedSeconds": 0}
    hop = float(np.median(np.diff(times)))
    window = max(1, round(.03 * sr))
    frame = np.maximum(0, np.minimum(len(audio) - 1, np.rint(times * sr).astype(int)))
    squared = np.r_[0, np.cumsum(np.square(audio, dtype=np.float64))]
    begin = np.maximum(0, frame - window // 2)
    end = np.minimum(len(audio), frame + window // 2 + 1)
    rms = np.sqrt((squared[end] - squared[begin]) / np.maximum(1, end - begin))
    floor = max(10 ** (-55 / 20), float(np.quantile(rms, .95)) * .018)
    lower, upper = (27.5, 440) if role == "bass" else (55, 1100)
    voiced = np.isfinite(f0) & (f0 >= lower) & (f0 <= upper) & (activation >= .03) & (rms >= floor)
    midi = np.zeros(len(f0))
    midi[voiced] = 69 + 12 * np.log2(f0[voiced] / 440)
    # Median only inside voiced islands; zeros must not bleed into onsets or rests.
    label = np.full(len(f0), -1, dtype=int)
    for start, stop, active in _runs(voiced.astype(int)):
        if not active:
            continue
        smooth = median_filter(midi[start:stop], size=5, mode="nearest")
        stable = round(float(smooth[0]))
        for pos, value in enumerate(smooth):
            if abs(value - stable) > .65:
                stable = round(float(value))
            label[start + pos] = stable
    # Brief neighboring deviations are vibrato/portamento, not separate score notes.
    for _ in range(2):
        runs = _runs(label)
        for index, (start, end, value) in enumerate(runs):
            if value < 0 or (end - start) * hop >= .085:
                continue
            prev = runs[index - 1] if index else None
            nxt = runs[index + 1] if index + 1 < len(runs) else None
            if prev and nxt and prev[2] == nxt[2] and prev[2] >= 0 and abs(prev[2] - value) <= 2:
                label[start:end] = prev[2]
            elif prev and prev[2] >= 0 and abs(prev[2] - value) <= 2:
                label[start:end] = prev[2]
            elif nxt and nxt[2] >= 0 and abs(nxt[2] - value) <= 2:
                label[start:end] = nxt[2]
    events = []
    discarded = 0
    for start, end, value in _runs(label):
        if value < 0:
            continue
        seconds = (end - start) * hop
        if seconds < .065:
            discarded += 1
            continue
        onset = max(0., float(times[start] - hop / 2))
        offset = min(len(audio) / sr, float(times[min(end - 1, len(times) - 1)] + hop / 2))
        strength = float(np.median(activation[start:end]))
        events.append([onset, offset, value, strength])
    details = {"method": "FCPE bundled model + voiced RMS gate + hysteresis/phrase monophonic decoding", "role": "dominant vocal line proposal" if role == "vocals" else "dominant bass-line proposal", "frameHopSeconds": hop, "voicedSeconds": round(float(np.sum(voiced) * hop), 3), "unvoicedSeconds": round(float(np.sum(~voiced) * hop), 3), "events": len(events), "shortUnstableRunsNotNotated": discarded, "activationThreshold": .03, "rmsGate": round(floor, 6), "polyphonicBackingPreservedInRawProject": True}
    return events, details

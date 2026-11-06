"""Experimental duration-constrained pitch segmentation; not the default decoder."""
from __future__ import annotations

import numpy as np


def runs(values: np.ndarray) -> list[tuple[int, int, int]]:
    if not len(values):
        return []
    starts = np.r_[0, np.flatnonzero(values[1:] != values[:-1]) + 1, len(values)]
    return [(int(a), int(b), int(values[a])) for a, b in zip(starts, starts[1:])]


def duration_viterbi(pitches: np.ndarray, transition_penalty: float = 1., minimum_frames: int = 6) -> np.ndarray:
    """Exact pitch/age state decoding; retain every frame rather than drop short runs later."""
    x = np.asarray(pitches, dtype=float)
    if not len(x):
        return np.array([], dtype=int)
    choices = np.arange(max(21, int(np.floor(x.min())) - 1), min(109, int(np.ceil(x.max())) + 2))
    cost = np.minimum(np.square(x[:, None] - choices[None, :]), 4)
    n, k = cost.shape
    age_count = min(minimum_frames, n)
    previous = np.full((k, age_count), np.inf)
    previous[:, 0] = cost[0]
    traceback = np.full((n, k, age_count), -1, dtype=np.int16)
    for frame in range(1, n):
        current = np.full_like(previous, np.inf)
        back = np.full((k, age_count), -1, dtype=np.int16)
        for age in range(1, age_count):
            current[:, age] = previous[:, age - 1] + cost[frame]
            back[:, age] = np.arange(k) * age_count + age - 1
        stay = previous[:, -1] + cost[frame]
        wins = stay < current[:, -1]
        current[wins, -1] = stay[wins]
        back[wins, -1] = np.arange(k)[wins] * age_count + age_count - 1
        if frame >= age_count:
            switch = np.broadcast_to(previous[:, -1, None] + transition_penalty, (k, k)).copy()
            np.fill_diagonal(switch, np.inf)
            indexes = np.argmin(switch, axis=0)
            current[:, 0] = switch[indexes, np.arange(k)] + cost[frame]
            back[:, 0] = indexes * age_count + age_count - 1
        previous, traceback[frame] = current, back
    state = int(np.argmin(previous))
    labels = np.empty(n, dtype=int)
    for frame in range(n - 1, -1, -1):
        pitch, age = divmod(state, age_count)
        labels[frame] = choices[pitch]
        if frame:
            state = int(traceback[frame, pitch, age])
    return labels


def decode_duration_contour(times: np.ndarray, f0: np.ndarray, activation: np.ndarray, audio: np.ndarray, sr: int, profile: str = "detailed") -> tuple[list, dict]:
    """Return an explicitly experimental alternative, preserving gaps and source frames."""
    times = np.asarray(times)
    f0 = np.asarray(f0)
    strength = np.asarray(activation)
    if len(times) < 2:
        return [], {"profile": profile, "events": 0}
    hop = float(np.median(np.diff(times)))
    frame = np.clip(np.rint(times * sr).astype(int), 0, len(audio) - 1)
    half_window = round(.015 * sr)
    begin, end = np.maximum(0, frame - half_window), np.minimum(len(audio), frame + half_window + 1)
    energy = np.r_[0., np.cumsum(np.square(audio, dtype=np.float64))]
    rms = np.sqrt((energy[end] - energy[begin]) / np.maximum(1, end - begin))
    floor = max(10 ** (-55 / 20), float(np.quantile(rms, .95)) * .018)
    voiced = np.isfinite(f0) & (f0 >= 55) & (f0 <= 1100) & (strength >= .03) & (rms >= floor)
    midi = np.zeros(len(times))
    midi[voiced] = 69 + 12 * np.log2(f0[voiced] / 440)
    labels = np.full(len(times), -1, dtype=int)
    minimum = max(1, round((.06 if profile == "detailed" else .10) / hop))
    penalty = 1. if profile == "detailed" else 2.
    short_islands = []
    for start, stop, active in runs(voiced.astype(int)):
        if not active:
            continue
        labels[start:stop] = duration_viterbi(midi[start:stop], penalty, minimum)
        if stop - start < minimum:
            short_islands.append([float(times[start]), float(times[stop - 1] + hop), stop - start])
    events = [[max(0., float(times[start] - hop / 2)), min(len(audio) / sr, float(times[stop - 1] + hop / 2)), pitch, float(np.median(strength[start:stop]))] for start, stop, pitch in runs(labels) if pitch >= 0]
    return events, {"profile": profile, "method": "duration-constrained Viterbi, per-frame capped squared error, explicit pitch-age states", "minimumSegmentSeconds": minimum * hop, "transitionPenalty": penalty, "events": len(events), "shortVoicedIslandsRetained": short_islands, "tradeoff": "More faithful frame assignment can produce dense ornamentation. Not automatically accepted as a readable score."}

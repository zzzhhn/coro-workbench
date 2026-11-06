"""Independent offline lead-note experiment. Not imported by the app pipeline.

The two frozen profiles share one acoustic segmentation path. ``metric_boundary``
adds a bounded joint onset/offset lattice; neither profile sees CREPE reference
pitch, changes a source project, or claims that note spelling is ground truth.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from time import perf_counter

import numpy as np
from scipy.ndimage import median_filter
from scipy.signal import find_peaks, resample_poly, stft


@dataclass(frozen=True)
class LeadNoteConfig:
    activation_floor: float = .03
    minimum_f0: float = 55.
    maximum_f0: float = 1100.
    pitch_deadband: float = .35
    capped_pitch_cost: float = 1.5
    event_penalty: float = .035
    short_duration_scale: float = .09
    short_duration_penalty: float = .10
    acoustic_attack_reward: float = .060
    onset_refractory_seconds: float = .09
    maximum_model_dropout_seconds: float = .035
    metric_boundary_limit_seconds: float = .030
    metric_reference_weight: float = .28


CONFIG = LeadNoteConfig()
PROFILES = ("acoustic_segments", "metric_boundary")


def runs(values: np.ndarray) -> list[tuple[int, int, int]]:
    if not len(values):
        return []
    boundaries = np.r_[0, np.flatnonzero(values[1:] != values[:-1]) + 1, len(values)]
    return [(int(a), int(b), int(values[a])) for a, b in zip(boundaries, boundaries[1:])]


def frame_acoustic_evidence(times: np.ndarray, audio: np.ndarray, sr: int) -> dict[str, np.ndarray | float]:
    """Energy valleys plus spectral novelty distinguish reattacks from vibrato."""
    times = np.asarray(times, dtype=float)
    audio = np.asarray(audio, dtype=np.float32)
    if not len(times) or not len(audio):
        return {name: np.zeros(len(times)) for name in ("rms", "flatness", "flux", "attack", "rise_db", "valley_db")} | {"rms_floor": .0018}
    if audio.ndim == 2:
        audio = audio.mean(axis=1)
    half = max(1, round(.015 * sr))
    frame = np.clip(np.rint(times * sr).astype(int), 0, len(audio) - 1)
    begin, end = np.maximum(0, frame - half), np.minimum(len(audio), frame + half + 1)
    prefix = np.r_[0., np.cumsum(np.square(audio, dtype=np.float64))]
    rms = np.sqrt((prefix[end] - prefix[begin]) / np.maximum(1, end - begin))
    floor = max(10 ** (-55 / 20), float(np.quantile(rms, .95)) * .018)
    target_sr = 16000
    divisor = np.gcd(sr, target_sr)
    signal = resample_poly(audio, target_sr // divisor, sr // divisor) if sr != target_sr else audio
    frame_size, frame_hop = 640, 160
    if len(signal) < frame_size:
        signal = np.pad(signal, (0, frame_size - len(signal)))
    frequencies, spectrum_times, spectrum = stft(signal, fs=target_sr, window="hann", nperseg=frame_size, noverlap=frame_size - frame_hop, nfft=1024, boundary="zeros", padded=True)
    magnitude = np.abs(spectrum[(frequencies >= 80) & (frequencies <= 6000)]).astype(float)
    flatness_raw = np.exp(np.mean(np.log(magnitude + 1e-8), axis=0)) / (np.mean(magnitude, axis=0) + 1e-8)
    difference = np.maximum(0, np.diff(magnitude, axis=1, prepend=magnitude[:, :1]))
    flux_raw = difference.sum(axis=0) / np.maximum(1e-8, magnitude.sum(axis=0))
    flux = np.interp(times, spectrum_times, flux_raw)
    flatness = np.interp(times, spectrum_times, flatness_raw)
    pre = np.interp(times - .030, times, rms, left=float(rms[0]), right=float(rms[-1]))
    earlier = np.interp(times - .090, times, rms, left=float(rms[0]), right=float(rms[-1]))
    post = np.interp(times + .025, times, rms, left=float(rms[0]), right=float(rms[-1]))
    rise_db = 20 * np.log10((post + floor * .1) / (pre + floor * .1))
    valley_db = 20 * np.log10((earlier + floor * .1) / (pre + floor * .1))
    # An energy rise by itself is a crescendo, not necessarily a new note.
    attack = np.clip((rise_db - 2.0) / 8.0, 0, 1) * np.clip(flux / .25, 0, 1)
    attack *= np.clip((valley_db + 1) / 5.0, 0, 1)
    attack[rms < floor] = 0
    return {"rms": rms, "rms_floor": floor, "flatness": flatness, "flux": flux, "attack": attack, "rise_db": rise_db, "valley_db": valley_db}


def _segment_island(midi: np.ndarray, weights: np.ndarray, attack: np.ndarray, hop: float) -> tuple[list[tuple[int, int, int]], dict]:
    """Semi-Markov path over observed pitch boundaries and acoustic attacks."""
    length = len(midi)
    if not length:
        return [], {"candidateBoundaries": 0}
    smooth = median_filter(midi, size=min(5, length // 2 * 2 + 1), mode="nearest")
    rounded = np.rint(smooth).astype(int)
    boundaries = {0, length, *map(int, np.flatnonzero(rounded[1:] != rounded[:-1]) + 1)}
    peaks, properties = find_peaks(attack, height=.45, distance=max(1, round(CONFIG.onset_refractory_seconds / hop)), prominence=.2)
    boundaries.update(map(int, peaks))
    # Long stable regions need no artificial maximum note duration.
    points = np.array(sorted(boundaries), dtype=int)
    pitches = np.arange(max(21, int(np.floor(smooth.min())) - 1), min(108, int(np.ceil(smooth.max())) + 1) + 1)
    distance = np.maximum(0, np.abs(smooth[:, None] - pitches[None, :]) - CONFIG.pitch_deadband)
    loss = np.minimum(CONFIG.capped_pitch_cost, distance ** 2) * weights[:, None] * hop
    cumulative = np.vstack([np.zeros(len(pitches)), np.cumsum(loss, axis=0)])
    count = len(points)
    costs = np.full(count, np.inf)
    predecessor = np.full(count, -1, dtype=int)
    choices = np.full(count, -1, dtype=int)
    costs[0] = -CONFIG.event_penalty
    peak_set = set(map(int, peaks))
    for stop_index in range(1, count):
        end = points[stop_index]
        starts = points[:stop_index]
        fitting = cumulative[end][None, :] - cumulative[starts]
        pitch_index = np.argmin(fitting, axis=1)
        fit = fitting[np.arange(stop_index), pitch_index]
        duration = (end - starts) * hop
        prominence = np.array([float(attack[start]) if start in peak_set else 0. for start in starts])
        duration_scale = CONFIG.short_duration_scale * (1 - .5 * prominence)
        short_penalty = CONFIG.short_duration_penalty * np.maximum(0, 1 - duration / np.maximum(hop, duration_scale)) ** 2
        boundary_cost = CONFIG.event_penalty - CONFIG.acoustic_attack_reward * prominence
        trial = costs[:stop_index] + fit + short_penalty + boundary_cost
        best = int(np.argmin(trial))
        costs[stop_index], predecessor[stop_index], choices[stop_index] = trial[best], best, int(pitches[pitch_index[best]])
    events = []
    index = count - 1
    while index > 0:
        before = int(predecessor[index])
        events.append((int(points[before]), int(points[index]), int(choices[index])))
        index = before
    events.reverse()
    return events, {"candidateBoundaries": count, "acousticReattackCandidates": len(peaks), "objective": float(costs[-1])}


def _boundary_grid(events: list[list], times: np.ndarray, voiced: np.ndarray, attack: np.ndarray, bpm: float, offset: float) -> tuple[list[list], dict]:
    """Joint boundary path: never drops collisions like a by-start dictionary."""
    if not events:
        return [], {"movedBoundaries": 0, "preservedEvents": 0}
    limit = CONFIG.metric_boundary_limit_seconds
    quarter = 60 / bpm
    options: list[list[tuple[float, float, float]]] = []
    for index, event in enumerate(events):
        a, b, pitch, strength = event[:4]
        onset_options = {float(a): 0.}
        offset_options = {float(b): 0.}
        for quantum in (.25, .125):
            step = quarter * quantum
            for source, table in ((a, onset_options), (b, offset_options)):
                target = max(0., offset + round((source - offset) / step) * step)
                shift = abs(target - source)
                if shift > limit:
                    continue
                center = (target + source) / 2
                is_voiced = bool(np.interp(center, times, voiced.astype(float)) > .7)
                extends_gap = target < a if source == a else target > b
                if extends_gap and shift > .012 and not is_voiced:
                    continue
                boundary_salience = float(np.interp(source, times, attack)) if source == a else 0.
                cost = (shift / limit) ** 2 * (1 + 2 * boundary_salience) - CONFIG.metric_reference_weight * (.9 if quantum == .125 else 1.)
                table[target] = min(cost, table.get(target, np.inf))
        candidates = [(start, stop, start_cost + stop_cost) for start, start_cost in onset_options.items() for stop, stop_cost in offset_options.items() if stop - start >= min(.03, b - a) - 1e-8]
        options.append(candidates)
    totals = [np.array([candidate[2] for candidate in options[0]])]
    back = [np.full(len(options[0]), -1, dtype=int)]
    for index in range(1, len(options)):
        previous_ends = np.array([candidate[1] for candidate in options[index - 1]])
        current = np.full(len(options[index]), np.inf)
        pointers = np.full(len(options[index]), -1, dtype=int)
        for j, candidate in enumerate(options[index]):
            available = np.where(previous_ends <= candidate[0] + 1e-8, totals[-1], np.inf)
            before = int(np.argmin(available))
            current[j] = available[before] + candidate[2]
            pointers[j] = before
        totals.append(current)
        back.append(pointers)
    choice = int(np.argmin(totals[-1]))
    if not np.isfinite(totals[-1][choice]):
        return [list(event) for event in events], {"movedBoundaries": 0, "preservedEvents": len(events), "fallback": "No valid joint metric path; original boundaries preserved"}
    output = [None] * len(events)
    shifts = []
    for index in range(len(events) - 1, -1, -1):
        a, b, _ = options[index][choice]
        shifts.extend([abs(a - events[index][0]), abs(b - events[index][1])])
        output[index] = [a, b, *events[index][2:]]
        choice = int(back[index][choice])
    return output, {"movedBoundaries": int(np.sum(np.array(shifts) > 1e-8)), "maximumBoundaryShiftSeconds": float(max(shifts, default=0)), "preservedEvents": len(output), "noOnsetDeduplication": True}


def decode_lead_note_proposal(times: np.ndarray, f0: np.ndarray, activation: np.ndarray, audio: np.ndarray, sr: int, *, profile: str = "acoustic_segments", bpm: float | None = None, beat_offset_seconds: float = 0., acoustic_evidence: dict | None = None) -> tuple[list[list], dict]:
    started = perf_counter()
    if profile not in PROFILES:
        raise ValueError(f"Unknown frozen profile: {profile}")
    times, f0, activation = map(lambda x: np.asarray(x, dtype=float), (times, f0, activation))
    if times.ndim != 1 or f0.shape != times.shape or activation.shape != times.shape:
        raise ValueError("times, f0 and activation must be equally sized vectors")
    if len(times) < 2:
        return [], {"profile": profile, "events": 0, "config": asdict(CONFIG), "runtimeSeconds": perf_counter() - started}
    if not np.all(np.isfinite(times)) or np.any(np.diff(times) <= 0):
        raise ValueError("Frame times must be finite and strictly increasing")
    if sr <= 0:
        raise ValueError("Invalid sample rate")
    hop = float(np.median(np.diff(times)))
    audio = np.asarray(audio)
    duration = len(audio) / sr
    features = acoustic_evidence if acoustic_evidence is not None else frame_acoustic_evidence(times, audio, sr)
    voiced = np.isfinite(f0) & (f0 >= CONFIG.minimum_f0) & (f0 <= CONFIG.maximum_f0) & (activation >= CONFIG.activation_floor) & (features["rms"] >= features["rms_floor"])
    midi = np.full(len(times), np.nan)
    midi[voiced] = 69 + 12 * np.log2(f0[voiced] / 440)
    filled = []
    for index, (a, b, flag) in enumerate(runs(voiced.astype(int))):
        if flag or a == 0 or b == len(times) or (b - a) * hop > CONFIG.maximum_model_dropout_seconds:
            continue
        if abs(midi[a - 1] - midi[b]) > .4 or np.mean(features["flatness"][a:b]) > .15 or np.min(features["rms"][a:b]) < features["rms_floor"] * 3:
            continue
        midi[a:b] = np.linspace(midi[a - 1], midi[b], b - a + 2)[1:-1]
        voiced[a:b] = True
        filled.append([float(times[a]), float(times[b])])
    events = []
    diagnostics = []
    glides = []
    for a, b, flag in runs(voiced.astype(int)):
        if not flag:
            continue
        weights = .4 + .6 * np.clip(activation[a:b], 0, 1)
        segments, info = _segment_island(midi[a:b], weights, np.asarray(features["attack"])[a:b], hop)
        diagnostics.append(info)
        for begin, end, pitch in segments:
            start = max(0., float(times[a + begin] - hop / 2))
            stop = min(duration, float(times[min(a + end - 1, len(times) - 1)] + hop / 2))
            if stop > start:
                events.append([start, stop, pitch, float(np.median(activation[a + begin:a + end]))])
        if b - a >= 12:
            slope = np.abs(np.gradient(median_filter(midi[a:b], size=5, mode="nearest"), hop))
            sustained = median_filter(slope, size=11, mode="nearest") > 4
            for begin, end, active in runs(sustained.astype(int)):
                if active and (end - begin) * hop >= .10:
                    glides.append([float(times[a + begin]), float(times[min(a + end, len(times) - 1)]), "Continuous slide/vibrato transition; discrete note boundary is not acoustically unique"])
    grid = {"applied": False}
    if profile == "metric_boundary":
        if bpm is None or not np.isfinite(bpm) or not 20 <= bpm <= 300:
            raise ValueError("metric_boundary requires a finite 20..300 BPM grid")
        events, grid = _boundary_grid(events, times, voiced, np.asarray(features["attack"]), float(bpm), beat_offset_seconds)
        grid["applied"] = True
    info = {"profile": profile, "method": "Evidence-boundary segmental path: robust pitch fit + event complexity + acoustic reattack + duration-shaped prior; optional bounded joint metric path", "config": asdict(CONFIG), "events": len(events), "runtimeSeconds": round(perf_counter() - started, 6), "frameHopSeconds": hop, "voicedSeconds": float(voiced.sum() * hop), "candidateBoundaries": sum(item["candidateBoundaries"] for item in diagnostics), "acousticReattackCandidates": sum(item.get("acousticReattackCandidates", 0) for item in diagnostics), "filledModelDropouts": filled, "glideUncertaintyIntervals": glides, "grid": grid, "referencePitchUsed": False, "defaultPipelineChanged": False, "rmsFloor": float(features["rms_floor"])}
    return events, info

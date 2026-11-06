"""Isolated conservative proposals for raw FCPE-missing frames.

Saved CREPE and classical pYIN are inputs, never accuracy references. No neural
models, app imports, disk writes, note editing or octave correction occur here.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from time import perf_counter

import numpy as np
from scipy.signal import resample_poly


@dataclass(frozen=True)
class VoiceRescueConfig:
    sample_rate: int = 8000
    frame_length: int = 1024
    hop_length: int = 160
    minimum_f0: float = 55.
    maximum_f0: float = 1100.
    pyin_resolution_semitones: float = .2
    pyin_probability: float = .70
    crepe_periodicity: float = .70
    agreement_cents: float = 35.
    minimum_autocorrelation: float = .70
    minimum_harmonic_fraction: float = .62
    minimum_individual_harmonic_fraction: float = .04
    minimum_supported_harmonics: int = 2
    octave_competitor_margin: float = .10
    minimum_sustained_seconds: float = .10
    maximum_neighbor_step_semitones: float = .70


CONFIG = VoiceRescueConfig()
VERSION = "missing-only-crepe-pyin-raw-harmonics-v1"


def _runs(values):
    boundaries = np.r_[0, np.flatnonzero(values[1:] != values[:-1]) + 1, len(values)]
    return [(int(a), int(b), bool(values[a])) for a, b in zip(boundaries, boundaries[1:]) if b > a]


def frame_rms(times, audio, sr, *, audio_offset_seconds=0.):
    """Same centered30ms RMS geometry as the existing standard vocal decoder."""
    times = np.asarray(times, dtype=float)
    audio = np.asarray(audio, dtype=np.float32)
    if audio.ndim == 2:
        audio = audio.mean(axis=1)
    if not len(audio):
        return np.zeros(len(times))
    half = max(1, round(.03 * sr)) // 2
    frame = np.clip(np.rint((times - audio_offset_seconds) * sr).astype(int), 0, len(audio) - 1)
    begin, end = np.maximum(0, frame - half), np.minimum(len(audio), frame + half + 1)
    energy = np.r_[0., np.cumsum(np.square(audio, dtype=np.float64))]
    return np.sqrt((energy[end] - energy[begin]) / np.maximum(1, end - begin))


def rms_floor(rms):
    return max(10 ** (-55 / 20), float(np.quantile(rms, .95)) * .018) if len(rms) else 10 ** (-55 / 20)


def fcpe_gate_diagnostics(times, f0, activation, rms, floor, start, end):
    selected = (times >= start) & (times < end)
    raw = np.isfinite(f0) & (f0 > 0)
    valid = raw & (f0 >= CONFIG.minimum_f0) & (f0 <= CONFIG.maximum_f0)
    active, audible = activation >= .03, rms >= floor
    count = lambda mask: int(np.sum(selected & mask))
    return {"frames": int(selected.sum()), "rawF0Exists": count(raw), "rawF0Missing": count(~raw), "validF0": count(valid), "outOfRangeExistingF0": count(raw & ~valid), "f0AndActivation": count(valid & active), "f0AndRMS": count(valid & audible), "passBoth": count(valid & active & audible), "activationOnlyRejected": count(valid & ~active & audible), "rmsOnlyRejected": count(valid & active & ~audible), "bothGatesRejected": count(valid & ~active & ~audible), "rmsFloor": float(floor)}


def estimate_classical_pitch(audio, sr, *, audio_offset_seconds=0.):
    """Classical local pYIN only; callers may cache these private measurements."""
    import librosa

    audio = np.asarray(audio, dtype=np.float32)
    if audio.ndim == 2:
        audio = audio.mean(axis=1)
    divisor = np.gcd(sr, CONFIG.sample_rate)
    signal = resample_poly(audio, CONFIG.sample_rate // divisor, sr // divisor) if sr != CONFIG.sample_rate else audio.copy()
    if not len(signal):
        return {"time": np.array([]), "f0": np.array([]), "probability": np.array([]), "voiced": np.array([], dtype=bool)}
    if len(signal) < CONFIG.frame_length:
        signal = np.pad(signal, (0, CONFIG.frame_length - len(signal)))
    started = perf_counter()
    f0, voiced, probability = librosa.pyin(signal, sr=CONFIG.sample_rate, fmin=CONFIG.minimum_f0, fmax=CONFIG.maximum_f0, frame_length=CONFIG.frame_length, hop_length=CONFIG.hop_length, resolution=CONFIG.pyin_resolution_semitones, n_thresholds=50, fill_na=np.nan, center=True)
    return {"time": np.arange(len(f0)) * CONFIG.hop_length / CONFIG.sample_rate + audio_offset_seconds, "f0": f0, "probability": probability, "voiced": voiced, "runtimeSeconds": perf_counter() - started}


def _nearest(times, reference_times, values, maximum_distance):
    if not len(reference_times):
        return np.full(len(times), np.nan)
    after = np.clip(np.searchsorted(reference_times, times), 0, len(reference_times) - 1)
    before = np.maximum(0, after - 1)
    index = np.where(abs(reference_times[before] - times) <= abs(reference_times[after] - times), before, after)
    result = np.asarray(values, dtype=float)[index].copy()
    result[abs(reference_times[index] - times) > maximum_distance] = np.nan
    return result


def _harmonic_fit(spectrum_power, frequencies, pitch):
    band = (frequencies >= 40) & (frequencies <= 3500)
    total = float(spectrum_power[band].sum()) + 1e-20
    union = np.zeros(len(frequencies), dtype=bool)
    fractions = []
    for harmonic in range(1, 9):
        center = harmonic * pitch
        if center > 3500:
            break
        selected = band & (abs(frequencies - center) <= max(16., center * .018))
        union |= selected
        fractions.append(float(spectrum_power[selected].sum() / total))
    strong = [index + 1 for index, fraction in enumerate(fractions) if fraction >= CONFIG.minimum_individual_harmonic_fraction]
    return float(spectrum_power[union].sum() / total), strong


def _raw_pitch_support(audio, sr, at, pitch):
    center = round(at * sr)
    half = CONFIG.frame_length // 2
    first, last = center - half, center + half
    segment = audio[max(0, first):min(len(audio), last)]
    segment = np.pad(segment, (max(0, -first), max(0, last - len(audio))))
    if len(segment) != CONFIG.frame_length:
        return 0., 0., 0, False, False
    segment = segment.astype(float) - float(np.mean(segment))
    lag = sr / pitch
    low = max(1, int(np.floor(lag)))
    high = min(len(segment) - 2, int(np.ceil(lag)))
    correlations = []
    for delay in {low, high}:
        a, b = segment[:-delay], segment[delay:]
        correlations.append(float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-20)))
    correlation = max(correlations, default=0.)
    power = np.abs(np.fft.rfft(segment * np.hanning(len(segment)), n=8192)) ** 2
    frequencies = np.fft.rfftfreq(8192, 1 / sr)
    fraction, harmonics = _harmonic_fit(power, frequencies, pitch)
    lower_fraction, lower_harmonics = _harmonic_fit(power, frequencies, pitch / 2)
    # An octave-lower candidate is competing only if its own odd harmonics exist.
    lower_is_supported = len(lower_harmonics) >= CONFIG.minimum_supported_harmonics and any(h % 2 for h in lower_harmonics)
    octave_conflict = lower_is_supported and lower_fraction > fraction + CONFIG.octave_competitor_margin
    return correlation, fraction, len(harmonics), any(h % 2 for h in harmonics), octave_conflict


def rescue_missing_voice_pitch(times, fcpe_f0, crepe_times, crepe_f0, crepe_periodicity, audio, sr, *, audio_offset_seconds=0., classical_evidence=None, minimum_rms=None):
    """Return zero-or-candidateHz proposals, never edits to existing estimates/notes.

    Every accepted frame was raw-missing, independently estimated by pYIN, agreed
    with saved CREPE and passed raw waveform checks. CREPE/pYIN are consumed
    evidence, so measuring agreement against them cannot establish accuracy.
    """
    started = perf_counter()
    times, fcpe_f0 = np.asarray(times, dtype=float), np.asarray(fcpe_f0, dtype=float)
    if times.ndim != 1 or times.shape != fcpe_f0.shape or len(times) < 2 or not np.all(np.isfinite(times)) or np.any(np.diff(times) <= 0):
        raise ValueError("times and fcpe_f0 must be equally sized vectors with at least two increasing finite times")
    if sr <= 0:
        raise ValueError("Invalid sample rate")
    audio = np.asarray(audio, dtype=np.float32)
    if audio.ndim == 2:
        audio = audio.mean(axis=1)
    if audio.ndim != 1 or not len(audio) or not np.all(np.isfinite(audio)):
        raise ValueError("Audio must be a finite nonempty mono or stereo waveform")
    if not (len(crepe_times) == len(crepe_f0) == len(crepe_periodicity)) or np.any(np.diff(crepe_times) <= 0):
        raise ValueError("CREPE evidence must have matching increasing time vectors")
    if classical_evidence is None:
        classical_evidence = estimate_classical_pitch(audio, sr, audio_offset_seconds=audio_offset_seconds)
    duration = len(audio) / sr
    raw_missing = ~np.isfinite(fcpe_f0) | (fcpe_f0 <= 0)
    in_audio = (times >= audio_offset_seconds) & (times < audio_offset_seconds + duration)
    crepe = _nearest(times, np.asarray(crepe_times), crepe_f0, .011)
    crepe_confidence = _nearest(times, np.asarray(crepe_times), crepe_periodicity, .011)
    pyin = _nearest(times, np.asarray(classical_evidence["time"]), classical_evidence["f0"], .011)
    pyin_confidence = _nearest(times, np.asarray(classical_evidence["time"]), classical_evidence["probability"], .011)
    crepe_ok = np.isfinite(crepe) & (crepe >= CONFIG.minimum_f0) & (crepe <= CONFIG.maximum_f0) & (crepe_confidence >= CONFIG.crepe_periodicity)
    pyin_ok = np.isfinite(pyin) & (pyin >= CONFIG.minimum_f0) & (pyin <= CONFIG.maximum_f0) & (pyin_confidence >= CONFIG.pyin_probability)
    agreement = np.full(len(times), np.inf)
    common = crepe_ok & pyin_ok
    agreement[common] = abs(1200 * np.log2(crepe[common] / pyin[common]))
    rms = frame_rms(times, audio, sr, audio_offset_seconds=audio_offset_seconds)
    floor = float(minimum_rms) if minimum_rms is not None else rms_floor(rms)
    if not np.isfinite(floor) or floor <= 0:
        raise ValueError("Minimum RMS must be positive and finite")
    initial = raw_missing & in_audio & common & (agreement <= CONFIG.agreement_cents) & (rms >= floor)
    divisor = np.gcd(sr, CONFIG.sample_rate)
    signal = resample_poly(audio, CONFIG.sample_rate // divisor, sr // divisor) if sr != CONFIG.sample_rate else audio
    raw = np.zeros((len(times), 5))
    for index in np.flatnonzero(initial):
        raw[index] = _raw_pitch_support(signal, CONFIG.sample_rate, times[index] - audio_offset_seconds, pyin[index])
    support = initial & (raw[:, 0] >= CONFIG.minimum_autocorrelation) & (raw[:, 1] >= CONFIG.minimum_harmonic_fraction) & (raw[:, 2] >= CONFIG.minimum_supported_harmonics) & raw[:, 3].astype(bool) & ~raw[:, 4].astype(bool)
    # Sustained support is assessed within missing-only islands. It never bridges
    # an existing FCPE frame, a noisy frame, or an unsupported transition.
    hop = float(np.median(np.diff(times)))
    discontinuity = np.zeros(len(times), dtype=bool)
    pair = support[1:] & support[:-1]
    discontinuity[1:][pair] = abs(12 * np.log2(pyin[1:][pair] / pyin[:-1][pair])) > CONFIG.maximum_neighbor_step_semitones
    support[discontinuity] = False
    accepted = support.copy()
    intervals = []
    for first, last, active in _runs(support):
        if not active:
            continue
        if (last - first) * hop < CONFIG.minimum_sustained_seconds - 1e-8:
            accepted[first:last] = False
        else:
            intervals.append({"startSeconds": float(times[first] - hop / 2), "endSeconds": float(times[last - 1] + hop / 2), "frames": last - first, "medianF0Hz": float(np.median(pyin[first:last])), "minimumPyinProbability": float(np.min(pyin_confidence[first:last])), "minimumCrepePeriodicity": float(np.min(crepe_confidence[first:last])), "maximumModelDisagreementCents": float(np.max(agreement[first:last]))})
    proposal = np.zeros(len(times))
    proposal[accepted] = pyin[accepted]
    counts = {"rawMissing": int(raw_missing.sum()), "missingAndCrepeEligible": int((raw_missing & crepe_ok).sum()), "missingAndPyinEligible": int((raw_missing & pyin_ok).sum()), "missingWithModelAgreement": int((raw_missing & common & (agreement <= CONFIG.agreement_cents)).sum()), "initialWithRMS": int(initial.sum()), "rawSupportedBeforeDuration": int(support.sum()), "accepted": int(accepted.sum()), "rejectedShortSupport": int((support & ~accepted).sum())}
    details = {"version": VERSION, "config": asdict(CONFIG), "scope": "Missing-only candidate; CREPE/pYIN/raw harmonic consistency is not ground-truth accuracy or lead-identity proof", "counts": counts, "acceptedSeconds": float(accepted.sum() * hop), "intervals": intervals, "minimumRMS": floor, "existingNonzeroF0Overwritten": 0, "defaultPipelineChanged": False, "neuralInferenceRerun": False, "runtimeSeconds": perf_counter() - started}
    return proposal, details


def merge_rescue_into_missing(fcpe_f0, proposal):
    """Explicit opt-in merge that preserves every finite positive FCPE estimate."""
    source, candidate = np.asarray(fcpe_f0, dtype=float), np.asarray(proposal, dtype=float)
    if source.shape != candidate.shape:
        raise ValueError("Proposal shape differs from FCPE contour")
    output = source.copy()
    permitted = (~np.isfinite(source) | (source <= 0)) & np.isfinite(candidate) & (candidate > 0)
    output[permitted] = candidate[permitted]
    return output

"""Independent audio-based harmonic candidates, never derived from decoded score notes."""
from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
from scipy.optimize import nnls

VERSION = "acoustic-cqt-nnls-harmony-0.2"
SAMPLE_RATE = 22050
HOP_LENGTH = 256
MIN_MIDI = 24
PITCHES = np.arange(MIN_MIDI, 96)
BIN_COUNT = 252
ALLOWED_STEMS = ("piano", "guitar", "other", "bass")
FORBIDDEN_STEMS = {"vocals", "lead", "backing", "drums"}
NAMES = ("C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B")
# Unweighted chord membership is independent of any key or previous score labels.
QUALITIES = {
    "": (0, 4, 7),
    "m": (0, 3, 7),
    "7": (0, 4, 7, 10),
    "maj7": (0, 4, 7, 11),
    "m7": (0, 3, 7, 10),
    "sus2": (0, 2, 7),
    "sus4": (0, 5, 7),
    "dim": (0, 3, 6),
    "dim7": (0, 3, 6, 9),
    "m7b5": (0, 3, 6, 10),
    "aug": (0, 4, 8),
    "6": (0, 4, 7, 9),
    "m6": (0, 3, 7, 9),
}


@dataclass
class AcousticFeatures:
    times: np.ndarray
    spectrum: np.ndarray
    bass_spectrum: np.ndarray
    rms: np.ndarray
    flatness: np.ndarray
    tuning: float
    duration: float
    evidence: dict


def file_sha256(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            value.update(block)
    return value.hexdigest()


def harmonic_dictionary() -> np.ndarray:
    dictionary = np.zeros((BIN_COUNT, len(PITCHES)), dtype=np.float64)
    bins = np.arange(BIN_COUNT)
    for index, pitch in enumerate(PITCHES):
        for harmonic in range(1, 7):
            center = (pitch - MIN_MIDI) * 3 + 36 * math.log2(harmonic)
            if center >= BIN_COUNT:
                continue
            dictionary[:, index] += np.exp(-.5 * ((bins - center) / .65) ** 2) / harmonic ** 1.6
        dictionary[:, index] *= (librosa.midi_to_hz(pitch) / 130.8128) ** -.5
    return dictionary


def _load_slice(path: Path, start: float, end: float | None) -> np.ndarray:
    info = sf.info(path)
    offset = min(info.frames, max(0, round(start * info.samplerate)))
    stop = info.frames if end is None else min(info.frames, round(end * info.samplerate))
    y, sr = sf.read(path, start=offset, stop=max(offset, stop), dtype="float32", always_2d=True)
    mono = y.mean(axis=1)
    if sr != SAMPLE_RATE:
        mono = librosa.resample(mono, orig_sr=sr, target_sr=SAMPLE_RATE)
    return mono


def extract_acoustic_features(stems: dict[str, Path], start_seconds: float = 0, end_seconds: float | None = None, output: Path | None = None) -> AcousticFeatures:
    if any(name in FORBIDDEN_STEMS for name in stems):
        raise ValueError("Harmony inference must exclude vocals, lead, backing and drums")
    if not stems or any(name not in ALLOWED_STEMS for name in stems):
        raise ValueError("Provide only piano/guitar/other/bass accompaniment stems")
    if not math.isfinite(start_seconds) or start_seconds < 0 or (end_seconds is not None and (not math.isfinite(end_seconds) or end_seconds <= start_seconds)):
        raise ValueError("A finite non-negative source start and later end are required")
    arrays = {name: _load_slice(Path(path), start_seconds, end_seconds) for name, path in stems.items()}
    if not arrays or min(map(len, arrays.values())) < SAMPLE_RATE // 4:
        raise ValueError("At least0.25s of aligned accompaniment audio is required")
    samples = min(map(len, arrays.values()))
    arrays = {name: audio[:samples] for name, audio in arrays.items()}
    non_bass = [audio for name, audio in arrays.items() if name != "bass"]
    accompaniment = np.sum(non_bass, axis=0) if non_bass else np.zeros(samples)
    bass = arrays.get("bass", np.zeros(samples))
    mixed = accompaniment + bass
    # Estimate tuning from audio, never from symbolic input or a declared score key.
    tuning = float(librosa.estimate_tuning(y=mixed, sr=SAMPLE_RATE, resolution=.01)) if np.max(np.abs(mixed)) > 1e-5 else 0.
    # Bass is contextual evidence, not an unlimited gain vote that masks quiet chord tones.
    harmonic_audio = accompaniment if np.max(np.abs(accompaniment)) > 1e-7 else bass
    spectrum = np.abs(librosa.cqt(harmonic_audio, sr=SAMPLE_RATE, hop_length=HOP_LENGTH, fmin=librosa.midi_to_hz(MIN_MIDI), n_bins=BIN_COUNT, bins_per_octave=36, tuning=tuning * 3, pad_mode="reflect"))
    bass_spectrum = np.abs(librosa.cqt(bass, sr=SAMPLE_RATE, hop_length=HOP_LENGTH, fmin=librosa.midi_to_hz(MIN_MIDI), n_bins=BIN_COUNT, bins_per_octave=36, tuning=tuning * 3, pad_mode="reflect")) if np.max(np.abs(bass)) > 1e-5 else np.zeros_like(spectrum)
    rms = librosa.feature.rms(y=mixed, frame_length=2048, hop_length=HOP_LENGTH)[0]
    flatness = librosa.feature.spectral_flatness(y=mixed, n_fft=2048, hop_length=HOP_LENGTH)[0]
    frame_count = min(spectrum.shape[1], len(rms))
    spectrum, bass_spectrum, rms, flatness = spectrum[:, :frame_count], bass_spectrum[:, :frame_count], rms[:frame_count], flatness[:frame_count]
    times = start_seconds + np.arange(frame_count) * HOP_LENGTH / SAMPLE_RATE
    evidence = {"version": VERSION, "sourceStems": [{"stem": name, "path": str(path), "sha256": file_sha256(Path(path))} for name, path in stems.items()], "explicitlyExcluded": sorted(FORBIDDEN_STEMS), "sourceStartSeconds": start_seconds, "sourceEndSeconds": start_seconds + samples / SAMPLE_RATE, "sampleRate": SAMPLE_RATE, "hopSamples": HOP_LENGTH, "tuningSemitones": tuning, "usesDecodedNotes": False, "usesScoreKey": False, "limitations": "CQT harmonic templates are approximate; source separation may leak voices into accompaniment. Acoustic candidates are not ground truth."}
    if output:
        output.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(output / "features.npz", time=times, spectrum=spectrum, bassSpectrum=bass_spectrum, rms=rms, flatness=flatness, tuning=tuning)
        (output / "feature-provenance.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return AcousticFeatures(times, spectrum, bass_spectrum, rms, flatness, tuning, samples / SAMPLE_RATE, evidence)


def pitch_profile(spectrum: np.ndarray, bass_spectrum: np.ndarray, dictionary: np.ndarray | None = None) -> dict:
    dictionary = harmonic_dictionary() if dictionary is None else dictionary
    amplitudes, residual = nnls(dictionary, spectrum.astype(float), maxiter=600)
    bass_amplitudes = nnls(dictionary, bass_spectrum.astype(float), maxiter=600)[0] if np.max(bass_spectrum) > 1e-7 else np.zeros(len(PITCHES))
    # Suppress only the numerical floor of the factorization, not arbitrary note candidates.
    floor = max(float(amplitudes.max(initial=0)) * .025, 1e-9)
    salience = np.maximum(0, amplitudes - floor)
    chroma = np.array([np.sum(salience[PITCHES % 12 == pitch_class]) for pitch_class in range(12)])
    bass_salience = bass_amplitudes if np.max(bass_amplitudes) > .05 * np.max(amplitudes, initial=0) else salience
    low = bass_salience * np.where(PITCHES < 60, 1., .10)
    if np.max(low, initial=0) > 0:
        active = np.flatnonzero(low >= np.max(low) * .25)
        lowest = active[np.argmin(PITCHES[active])]
        low *= np.exp(-np.maximum(0, PITCHES - PITCHES[lowest]) / 12)
    bass_chroma = np.array([np.sum(low[PITCHES % 12 == pitch_class]) for pitch_class in range(12)])
    if chroma.max(initial=0) > 0:
        chroma /= chroma.max()
    if bass_chroma.sum() > 0:
        bass_chroma /= bass_chroma.sum()
        if chroma.max(initial=0) > 0:
            chroma += .2 * bass_chroma / max(float(bass_chroma.max()), 1e-9)
            chroma /= chroma.max()
    top = np.argsort(salience)[::-1][:12]
    return {"chroma": chroma, "bassChroma": bass_chroma, "pitchSalience": salience, "spectralResidualRatio": float(residual / max(np.linalg.norm(spectrum), 1e-9)), "topPitches": [{"midi": int(PITCHES[index]), "salience": round(float(salience[index]), 5)} for index in top if salience[index] > 0]}


def chord_candidates(chroma: np.ndarray, bass_chroma: np.ndarray | None = None, top: int = 5) -> list[dict]:
    vector = np.asarray(chroma, dtype=float)
    if vector.shape != (12,) or not np.isfinite(vector).all() or np.any(vector < 0):
        raise ValueError("Chroma must have12 finite non-negative values")
    if float(vector.max(initial=0)) < 1e-9:
        return [{"symbol": "N", "root": None, "quality": "N", "pitches": [], "pitchClasses": [], "score": 0., "fit": 0., "missingToneEvidence": 1., "bassSupport": 0.}]
    vector = np.sqrt(vector / vector.max())
    bass = np.zeros(12) if bass_chroma is None else np.asarray(bass_chroma, dtype=float)
    if bass.shape != (12,) or not np.isfinite(bass).all() or np.any(bass < 0):
        raise ValueError("Bass chroma must have12 finite non-negative values")
    candidates = []
    for root in range(12):
        for quality, intervals in QUALITIES.items():
            pcs = [(root + interval) % 12 for interval in intervals]
            template = np.zeros(12)
            template[pcs] = 1
            fit = float(np.dot(vector, template) / max(np.linalg.norm(vector) * np.linalg.norm(template), 1e-9))
            missing = float(np.mean(np.maximum(0, .2 - vector[pcs]) / .2))
            supported = float(bass[root])
            score = fit - .12 * missing + .055 * supported
            # This is a fit score, deliberately not a softmax probability or calibrated confidence.
            candidates.append({"symbol": NAMES[root] + quality, "root": root, "quality": quality or "major", "pitches": [48 + root + i for i in intervals], "pitchClasses": pcs, "score": round(score, 6), "fit": round(fit, 6), "missingToneEvidence": round(missing, 6), "bassSupport": round(supported, 6)})
    return sorted(candidates, key=lambda candidate: candidate["score"], reverse=True)[:top]


def infer_audio_harmony(features: AcousticFeatures, bpm: float, offset_seconds: float, beats_per_window: float = 2, output: Path | None = None) -> dict:
    if not math.isfinite(bpm) or bpm <= 0 or not math.isfinite(offset_seconds) or beats_per_window not in (.5, 1, 2, 4):
        raise ValueError("PositiveBPM and a supported beat window (.5/1/2/4) required")
    source_start = float(features.evidence["sourceStartSeconds"])
    source_end = float(features.evidence["sourceEndSeconds"])
    first_beat = max(0, math.floor((source_start - offset_seconds) * bpm / 60 / beats_per_window) * beats_per_window)
    last_beat = (source_end - offset_seconds) * bpm / 60
    dictionary = harmonic_dictionary()
    noise_floor = max(1e-5, float(np.quantile(features.rms, .95)) * .008)
    segments = []
    for beat in np.arange(first_beat, last_beat, beats_per_window):
        expected_start = offset_seconds + beat * 60 / bpm
        expected_end = offset_seconds + (beat + beats_per_window) * 60 / bpm
        start, end = max(source_start, expected_start), min(source_end, expected_end)
        if end - start < .1:
            continue
        # Trim transients at boundaries; evidence must still come from inside the stated interval.
        left, right = start + min(.06, (end - start) * .1), end - min(.025, (end - start) * .04)
        frames = (features.times >= left) & (features.times < right)
        if not frames.any():
            continue
        energy = float(np.sqrt(np.mean(features.rms[frames] ** 2)))
        spectrum = np.mean(features.spectrum[:, frames], axis=1)
        bass_spectrum = np.mean(features.bass_spectrum[:, frames], axis=1)
        profile = pitch_profile(spectrum, bass_spectrum, dictionary)
        candidates = chord_candidates(profile["chroma"], profile["bassChroma"], top=5)
        harmonic_count = int(np.count_nonzero(profile["chroma"] >= .20))
        silence = energy < noise_floor
        spectral_flatness = float(np.median(features.flatness[frames]))
        flat = spectral_flatness > .15 or (profile["spectralResidualRatio"] > .75 and harmonic_count >= 9)
        if silence or flat or harmonic_count < 2:
            label, status = "N", "no_harmonic_evidence"
            reason = "silence_or_very_low_accompaniment" if silence else "inharmonic_or_flat_spectrum" if flat else "insufficient_distinct_pitch_classes"
        else:
            label = candidates[0]["symbol"]
            margin = candidates[0]["score"] - candidates[1]["score"]
            status = "candidate" if margin >= .035 and candidates[0]["fit"] >= .72 else "ambiguous"
            reason = "audio_template_fit_with_bass_evidence" if status == "candidate" else "top_candidates_close_or_weak_fit"
        margin = candidates[0]["score"] - candidates[1]["score"] if len(candidates) > 1 else 0.
        clipped_beat = (start - offset_seconds) * bpm / 60
        clipped_duration = (end - start) * bpm / 60
        base = {"start": round(float(clipped_beat), 6), "duration": round(float(clipped_duration), 6), "gridStartBeat": round(float(beat), 6), "sourceStartSeconds": round(start, 6), "sourceEndSeconds": round(end, 6), "symbol": label, "status": status, "reason": reason, "fitMargin": round(float(margin), 6), "confidenceMeaning": "uncalibrated acoustic fit, not correctness probability", "candidates": candidates, "evidence": {"rms": round(energy, 6), "silenceThreshold": round(noise_floor, 6), "spectralFlatness": round(spectral_flatness, 6), "chroma": np.round(profile["chroma"], 5).tolist(), "bassChroma": np.round(profile["bassChroma"], 5).tolist(), "spectralResidualRatio": round(profile["spectralResidualRatio"], 5), "topPitches": profile["topPitches"]}}
        segments.append(base)
    proposed = []
    for segment in segments:
        pitches = [] if segment["symbol"] == "N" else segment["candidates"][0]["pitches"]
        proposed.append({"start": segment["start"], "duration": segment["duration"], "symbol": segment["symbol"], "pitches": pitches, "status": segment["status"], "sourceStartSeconds": segment["sourceStartSeconds"], "sourceEndSeconds": segment["sourceEndSeconds"]})
    report = {"version": VERSION, "method": "Audio-only tuned CQT + harmonic NNLS salience + chord template/bass scoring", "grid": {"bpm": bpm, "offsetSeconds": offset_seconds, "windowBeats": beats_per_window}, "provenance": features.evidence, "usesDecodedNotes": False, "usesScoreKey": False, "requiresExplicitApply": True, "segments": segments, "proposedChords": proposed, "scope": "Reversible candidates only. No ground-truth song labels; abstention or alternatives retained. No existing score changes."}
    if output:
        output.mkdir(parents=True, exist_ok=True)
        (output / "harmony-candidates.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report

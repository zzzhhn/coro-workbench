"""Audio-derived accompaniment harmony, with the symbolic alternative retained."""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import soundfile as sf

from .storage import JobStatus

ACCOMPANIMENT = ("piano", "guitar", "bass", "other")


def score_chords(report: dict, bpm: float, offset_seconds: float, total_beats: float, quantum: float = .25) -> tuple[list[dict], dict]:
    if not all(math.isfinite(value) for value in (bpm, offset_seconds, total_beats, quantum)) or min(bpm, total_beats, quantum) <= 0:
        raise ValueError("Invalid harmony grid")
    result = []
    moved = []
    skipped = 0
    no_chord_seconds = 0.
    for segment in report["segments"]:
        left, right = float(segment["sourceStartSeconds"]), float(segment["sourceEndSeconds"])
        if not math.isfinite(left) or not math.isfinite(right) or right <= left:
            raise ValueError("Invalid harmony source interval")
        raw_start = (left - offset_seconds) * bpm / 60
        raw_end = (right - offset_seconds) * bpm / 60
        start = max(0., min(total_beats, round(raw_start / quantum) * quantum))
        end = max(0., min(total_beats, round(raw_end / quantum) * quantum))
        if segment["symbol"] == "N":
            no_chord_seconds += right - left
            continue
        if end <= start:
            skipped += 1
            continue
        pitches = list(segment["pitches"])
        bass = segment.get("bassPitchClass")
        if bass is not None and bass not in {pitch % 12 for pitch in pitches}:
            pitches.append(36 + int(bass))
        if not pitches or any(not isinstance(pitch, int) or not 0 <= pitch <= 127 for pitch in pitches):
            raise ValueError("Invalid harmonic pitches")
        symbol = segment["symbol"]
        if result and start < result[-1]["start"] + result[-1]["duration"] - 1e-8:
            raise ValueError("Overlapping audio harmony segments")
        if result and result[-1]["symbol"] == symbol and result[-1]["pitches"] == pitches and abs(result[-1]["start"] + result[-1]["duration"] - start) < 1e-8:
            result[-1]["duration"] = end - result[-1]["start"]
        else:
            result.append({"start": start, "duration": end - start, "symbol": symbol, "pitches": pitches})
        moved.extend([abs(start - raw_start) * 60 / bpm, abs(end - raw_end) * 60 / bpm])
    return result, {"quantumBeats": quantum, "shortSegmentsCollapsedByGrid": skipped,
                    "noChordSeconds": no_chord_seconds, "maxBoundaryShiftSeconds": max(moved, default=0.),
                    "outputChords": len(result), "confidenceAvailable": False}


def accompaniment_harmony(directory: Path, stems: dict[str, Path], bpm: float, offset_seconds: float,
                          total_beats: float, status: JobStatus | None = None) -> tuple[list[dict], dict]:
    from .chordino import infer_chordino, sha

    selected = {name: Path(stems[name]) for name in ACCOMPANIMENT if name in stems}
    if not selected:
        raise ValueError("No separated accompaniment is available")
    if status:
        status.check_cancelled()
        status.update(95, "harmony", "正在从分离伴奏辨识和弦与转位，不从转写音符反猜。")
    infos = {name: sf.info(path) for name, path in selected.items()}
    sample_rates = {info.samplerate for info in infos.values()}
    frame_counts = {info.frames for info in infos.values()}
    if len(sample_rates) != 1 or len(frame_counts) != 1:
        raise ValueError("Accompaniment stems are not sample-aligned")
    sample_rate, frames = next(iter(sample_rates)), next(iter(frame_counts))
    target = directory / "audio-harmony"
    target.mkdir(exist_ok=True)
    mono = np.zeros(frames, dtype=np.float32)
    hashes = {}
    for name, path in selected.items():
        if status:
            status.check_cancelled()
        hashes[name] = sha(path)
        audio, _ = sf.read(path, dtype="float32", always_2d=True)
        mono += audio.mean(axis=1)
    mixed = target / "accompaniment.wav"
    sf.write(mixed, mono, sample_rate, subtype="FLOAT")
    report = infer_chordino(mixed, target / "chordino", bpm=bpm, offset_seconds=offset_seconds,
                           timeout_seconds=max(60., frames / sample_rate),
                           cancel_check=(lambda: status.check_cancelled()) if status else None)
    report["accompaniment"] = {"stems": list(selected), "sourceSha256": hashes, "excluded": ["vocals", "lead", "backing", "drums"],
                               "method": "Sample-aligned mono sum; no remixing, gain normalization, or source writes"}
    if any(sha(path) != hashes[name] for name, path in selected.items()):
        raise ValueError("Accompaniment changed during analysis")
    chords, editorial = score_chords(report, bpm, offset_seconds, total_beats)
    report["scoreGridEditorial"] = editorial
    return chords, report

"""Native offline Chordino backend. A score proposal, never an edited source project."""
from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import os
import re
import subprocess
from pathlib import Path
from time import monotonic
from typing import Callable

import numpy as np
import soundfile as sf
import mir_eval.chord

from .config import ROOT

VERSION = 'chordino-vamp-1.1-native-1'
RUNTIME = ROOT / 'models/chordino'
HOST = RUNTIME / 'sonic-annotator'
PLUGIN_DIR = RUNTIME / 'vamp'
PLUGIN = PLUGIN_DIR / 'nnls-chroma.dylib'
TRANSFORM = RUNTIME / 'chordino-harte.n3'
PINNED_SHA256 = {
    'host': 'c34425592722fbe4727d3d79cd84272d5e398c418ccb46586cd8ef7780aaa4fb',
    'plugin': '22b001129db5beec65abb8ac6952be6ed2cd2d809aec3d8ebb50d2495afc2dd6',
    'transform': '11e8b7e12530b574c2fec6fa913feea56c9ee81437d59ba4f6d2b20dbd115523',
}
NAMES = ('C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B')


def sha(path: Path) -> str:
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def runtime_health() -> dict:
    paths = {'host': HOST, 'plugin': PLUGIN, 'transform': TRANSFORM}
    hashes = {key: sha(path) if path.is_file() else None for key, path in paths.items()}
    ready = all(hashes[key] == value for key, value in PINNED_SHA256.items())
    return {'ready': ready and TRANSFORM.is_file() and not (PLUGIN_DIR / 'chord.dict').exists(), 'backend': VERSION, 'sourceRevision': '4c5f214a75cb354f8d8c933e161377c5b4d83713', 'hostVersion': '1.7', 'hashes': hashes, 'requiresNetwork': False, 'modelWeights': False, 'license': 'Chordino and host GPL-2.0-or-later; attribution/corresponding-source requirements apply to redistribution', 'transformSha256': sha(TRANSFORM) if TRANSFORM.is_file() else None}


def chord_identity(label: str) -> dict:
    """Convert upstream Harte notation without treating every chord as a triad."""
    if label == 'N':
        return {'symbol': 'N', 'root': None, 'quality': 'N', 'bassPitchClass': None, 'pitchClasses': [], 'pitches': []}
    root, relative, bass = mir_eval.chord.encode(label)
    pitch_classes = sorted((int(root) + np.flatnonzero(relative)).tolist())
    pitch_classes = sorted({pitch % 12 for pitch in pitch_classes})
    _, quality, _, _ = mir_eval.chord.split(label)
    suffix = {'maj': '', 'min': 'm', 'min7': 'm7', 'maj6': '6', 'min6': 'm6', 'hdim7': 'm7b5'}.get(quality, quality)
    bass_pc = int((root + bass) % 12)
    symbol = NAMES[root] + suffix
    if bass_pc != root:
        symbol += '/' + NAMES[bass_pc]
    return {'symbol': symbol, 'root': int(root), 'quality': quality, 'bassPitchClass': bass_pc, 'pitchClasses': pitch_classes, 'pitches': [48 + int(root) + int(interval) for interval in np.flatnonzero(relative)]}


def parse_chordino_csv(text: str, source_start: float, duration: float, *, bpm: float | None = None, offset_seconds: float = 0.) -> list[dict]:
    if not math.isfinite(source_start) or source_start < 0 or not math.isfinite(duration) or duration <= 0:
        raise ValueError('Invalid source interval')
    if bpm is not None and (not math.isfinite(bpm) or bpm <= 0):
        raise ValueError('Positive finite BPM required')
    if not math.isfinite(offset_seconds):
        raise ValueError('Finite beat offset required')
    changes = []
    for row in csv.reader(io.StringIO(text)):
        if not row:
            continue
        # --csv-omit-filename means exactly timestamp,label for this output.
        if len(row) != 2:
            raise ValueError('Unexpected Chordino CSV schema')
        timestamp, label = float(row[0]), row[1]
        if not math.isfinite(timestamp) or timestamp < -1e-7 or timestamp > duration + .5:
            raise ValueError('Invalid Chordino timestamp')
        identity = chord_identity(label)
        if changes and timestamp < changes[-1][0] - 1e-7:
            raise ValueError('Chordino changes out of source order')
        changes.append((max(0., min(duration, timestamp)), label, identity))
    segments = []
    for index, (start, label, identity) in enumerate(changes):
        end = changes[index + 1][0] if index + 1 < len(changes) else duration
        if end - start < 1e-7:
            continue
        segment = {'sourceStartSeconds': round(source_start + start, 9), 'sourceEndSeconds': round(source_start + end, 9), 'upstreamLabel': label, **identity, 'status': 'unreviewed', 'confidence': None}
        if index == len(changes) - 1 and label == 'N':
            segment['terminalNoChordSentinel'] = True
        if bpm is not None:
            segment['start'] = (source_start + start - offset_seconds) * bpm / 60
            segment['duration'] = (end - start) * bpm / 60
        segments.append(segment)
    return segments


def infer_chordino(audio_path: Path, output: Path, *, start_seconds: float = 0., end_seconds: float | None = None, bpm: float | None = None, offset_seconds: float = 0., timeout_seconds: float = 120., cancel_check: Callable[[], bool] | None = None) -> dict:
    """Run a local aligned mono crop, preserving exact original physical seconds.

    Source may be the original mixture or an explicitly named accompaniment mix.
    The caller must retain provenance of any stem combination it constructs.
    """
    audio_path, output = Path(audio_path).resolve(), Path(output).resolve()
    if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
        raise ValueError('Finite positive timeout required')
    if audio_path == output / 'analysis-mono.wav':
        raise ValueError('Input must not be the output analysis-mono.wav')
    if bpm is not None and (not math.isfinite(bpm) or bpm <= 0):
        raise ValueError('Positive finite BPM required')
    if not math.isfinite(offset_seconds):
        raise ValueError('Finite beat offset required')
    health = runtime_health()
    if not health['ready']:
        raise RuntimeError('Pinned local Chordino runtime is unavailable or changed')
    if not math.isfinite(start_seconds) or start_seconds < 0 or (end_seconds is not None and (not math.isfinite(end_seconds) or end_seconds <= start_seconds)):
        raise ValueError('Finite nonnegative source start and later end required')
    info = sf.info(audio_path)
    start_sample = min(info.frames, round(start_seconds * info.samplerate))
    end_sample = info.frames if end_seconds is None else min(info.frames, round(end_seconds * info.samplerate))
    if end_sample - start_sample < info.samplerate * .25:
        raise ValueError('At least0.25s of source audio required')
    output.mkdir(parents=True, exist_ok=True)
    before = sha(audio_path)
    audio, sr = sf.read(audio_path, start=start_sample, stop=end_sample, dtype='float32', always_2d=True)
    mono = audio.mean(axis=1)
    if not np.isfinite(mono).all():
        raise ValueError('Source has non-finite samples')
    # All computation is local; no URLs or network decoder input are accepted.
    crop = output / 'analysis-mono.wav'
    sf.write(crop, mono, sr, subtype='FLOAT')
    env = dict(os.environ, VAMP_PATH=str(PLUGIN_DIR))
    command = [str(HOST), '-q', '-t', str(TRANSFORM), str(crop), '-w', 'csv', '--csv-stdout', '--csv-omit-filename', '--csv-digits', '9']
    started = monotonic()
    # Inherit the worker process group: cancelling that worker also stops this host.
    # communicate drains both pipes and optional polling cancellation never starts a new session.
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, cwd=output)
    try:
        while True:
            if cancel_check is not None and cancel_check():
                raise InterruptedError('Chordino cancelled')
            remaining = timeout_seconds - (monotonic() - started)
            if remaining <= 0:
                raise TimeoutError('Chordino timeout')
            try:
                stdout, stderr = process.communicate(timeout=min(.1, remaining))
                break
            except subprocess.TimeoutExpired:
                continue
    except BaseException:
        process.kill()
        process.communicate()
        raise
    (output / 'raw-changes.csv').write_text(stdout)
    (output / 'runtime.log').write_text(stderr)
    if process.returncode:
        raise RuntimeError(f'Chordino failed with exit code{process.returncode}: {stderr[-800:]}')
    source_start = start_sample / sr
    duration = len(mono) / sr
    segments = parse_chordino_csv(stdout, source_start, duration, bpm=bpm, offset_seconds=offset_seconds)
    assert sha(audio_path) == before, 'Source changed during harmony inference'
    report = {'version': VERSION, 'method': 'Independent native NNLS Chroma + Chordino HMM/Viterbi; default dictionary with Harte labels; sus and dim7 limitations retained', 'input': {'path': str(audio_path), 'sha256': before, 'sourceStartSeconds': source_start, 'sourceEndSeconds': source_start + duration, 'sampleRate': sr, 'channelsBeforeMono': info.channels, 'monoCropSha256': sha(crop)}, 'runtime': health, 'runtimeSeconds': round(monotonic() - started, 4), 'grid': {'bpm': bpm, 'offsetSeconds': offset_seconds}, 'segments': segments, 'proposedChords': [{key: segment[key] for key in ('start', 'duration', 'symbol', 'pitches', 'sourceStartSeconds', 'sourceEndSeconds') if key in segment} for segment in segments], 'codeSha256': sha(Path(__file__)), 'usesDecodedNotes': False, 'usesScoreKey': False, 'confidenceMeaning': 'Upstream chord labels have no calibrated correctness confidence; N includes an upstream terminal sentinel', 'requiresReview': True, 'sourceChanged': False, 'scope': 'A reversible candidate proposal. A stable path or agreement with another model is not human chord accuracy.'}
    (output / 'harmony.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    return report

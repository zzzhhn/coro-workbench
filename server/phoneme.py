"""Optional isolated phoneme-informed boundaries with real, same-waveform FCPE F0.

Health uses the standard library only. Inference never installs or downloads.
The caller owns the FCPE contour's waveform identity; the adapter checks its
timebase and records both input hashes, without inventing pitch or confidence.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / 'models/phoneme-ast'
SOURCE_COMMIT = 'b2fcd9ea0f7898a8989c7e65781052d1ffc81094'
MODEL_SHA256 = 'e56d1c7438f10afb61bbfe54a856a0355d4556fca6038dc67567fe68930ade17'
MODEL_BYTES = 106129108
CORE_SECONDS = 20.
CONTEXT_SECONDS = 1.
MAX_SECONDS = 300.
EXPECTED_VERSIONS = {'torch': '2.5.1', 'torchaudio': '2.5.1', 'nnAudio': '0.3.2',
                     'wquantiles': '0.6', 'librosa': '0.10.2.post1', 'numpy': '1.26.4',
                     'scipy': '1.14.1', 'soundfile': '0.13.1'}
_INTEGRITY_CACHE: dict = {}


def _file_digest(path: Path) -> str:
    info = path.stat()
    key = (str(path), info.st_size, info.st_mtime_ns, info.st_ctime_ns)
    if key not in _INTEGRITY_CACHE:
        digest = hashlib.sha256()
        with path.open('rb') as source:
            for block in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(block)
        # Bound cache growth during repeated local setup/replacement.
        if len(_INTEGRITY_CACHE) > 64:
            _INTEGRITY_CACHE.clear()
        _INTEGRITY_CACHE[key] = digest.hexdigest()
    return _INTEGRITY_CACHE[key]


def _source_integrity(source: Path) -> list[str]:
    try:
        commit = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'],
                                         text=True, stderr=subprocess.DEVNULL, timeout=5).strip()
        dirty = subprocess.check_output(['git', '-C', str(source), 'status', '--porcelain',
                                         '--untracked-files=normal'], text=True,
                                        stderr=subprocess.DEVNULL, timeout=5).strip()
        errors = []
        if commit != SOURCE_COMMIT:
            errors.append('Official phoneme source commit mismatch')
        if dirty:
            errors.append('Official phoneme source contains local changes or untracked files')
        return errors
    except (OSError, subprocess.SubprocessError):
        return ['Cannot verify official phoneme source Git checkout']


def runtime_health() -> dict:
    """Lightweight integrity/readiness check; no NumPy, Torch or model imports."""
    required = [RUNTIME / '.venv/bin/python', RUNTIME / 'model.pt',
                RUNTIME / 'source/phn_ast/model.py', RUNTIME / 'source/phn_ast/decoding.py',
                RUNTIME / 'runtime-manifest.json', ROOT / 'server/phoneme_runner.py']
    missing = [str(path) for path in required if not path.is_file()]
    errors = []
    if not missing:
        try:
            if not os.access(RUNTIME / '.venv/bin/python', os.X_OK):
                errors.append('Phoneme runtime Python is not executable')
            model = RUNTIME / 'model.pt'
            if model.stat().st_size != MODEL_BYTES or _file_digest(model) != MODEL_SHA256:
                errors.append('Phoneme checkpoint integrity mismatch')
            manifest = json.loads((RUNTIME / 'runtime-manifest.json').read_text())
            if (manifest['sourceCommit'] != SOURCE_COMMIT or manifest['checkpointSha256'] != MODEL_SHA256
                    or not str(manifest['python']).startswith('3.11.')
                    or manifest['requirementsSha256'] != _file_digest(ROOT / 'scripts/setup-phoneme.requirements.txt')):
                errors.append('Phoneme runtime manifest does not match pinned setup')
            import importlib.metadata
            installed = {(distribution.metadata.get('Name') or '').lower(): distribution.version
                         for distribution in importlib.metadata.distributions(
                             path=[str(RUNTIME / '.venv/lib/python3.11/site-packages')])}
            for name, expected in EXPECTED_VERSIONS.items():
                if str(installed.get(name.lower()) or '').split('+')[0] != expected:
                    errors.append(f'Phoneme runtime dependency missing or changed: {name}=={expected}')
            errors.extend(_source_integrity(RUNTIME / 'source'))
        except (OSError, ValueError, KeyError, TypeError) as error:
            errors.append(f'Invalid phoneme runtime installation: {error}')
    return {'ready': not missing and not errors, 'missing': missing, 'integrityErrors': errors,
            'engine': 'Phoneme-informed boundaries + FCPE pitch', 'sourceCommit': SOURCE_COMMIT,
            'checkpointSha256': MODEL_SHA256, 'defaultDevice': 'cpu', 'cpuThreads': 1,
            'maximumSeconds': MAX_SECONDS, 'optional': True}


def _load_contour(path: Path, duration: float):
    """Reject malformed or shifted inputs; keep real missing/unvoiced cells."""
    import numpy as np
    with np.load(path, allow_pickle=False) as archive:
        arrays = [np.asarray(archive[key], dtype=float) for key in ('time', 'f0', 'activation')]
    times, frequency, activation = arrays
    if (any(a.ndim != 1 for a in arrays) or not len(times)
            or any(a.shape != times.shape for a in arrays)):
        raise ValueError('FCPE contour must contain equally sized nonempty time/f0/activation vectors')
    if (not np.all(np.isfinite(times)) or np.any(np.diff(times) <= 0)
            or np.any(np.isinf(frequency)) or np.any(frequency < 0)
            or not np.all(np.isfinite(activation)) or np.any((activation < 0) | (activation > 1))):
        raise ValueError('Invalid FCPE contour times, frequencies or activation values')
    hop = float(np.median(np.diff(times))) if len(times) > 1 else .01
    tolerance = max(.05, 3 * hop)
    if (not 0 < hop <= .1 or times[0] < 0 or times[0] > max(.02, hop)
            or times[-1] > duration + tolerance
            or times[-1] < duration - tolerance):
        raise ValueError('FCPE contour must use the complete same-waveform zero-based timebase')
    return times, frequency, activation


def _validate_events(events, duration: float) -> list[dict]:
    if not isinstance(events, list):
        raise ValueError('Phoneme events must be a list')
    previous_end = 0.
    for event in events:
        if not isinstance(event, dict):
            raise ValueError('Invalid phoneme event')
        a, b, pitch = (event.get(key) for key in ('source_start_seconds', 'source_end_seconds', 'midi_pitch'))
        if (isinstance(a, bool) or isinstance(b, bool) or not isinstance(a, (int, float))
                or not isinstance(b, (int, float)) or not math.isfinite(a) or not math.isfinite(b)
                or not 0 <= a < b <= duration + 1e-6
                or isinstance(pitch, bool) or not isinstance(pitch, int) or not 1 <= pitch <= 127
                or a < previous_end - 1e-6):
            raise ValueError('Phoneme returned invalid, overlapping or unordered note intervals')
        previous_end = b
    return events


def _stitch_context_events(events: list[dict]) -> list[dict]:
    """Join only events which both models predict across the same core cut."""
    stitched = []
    for original in events:
        event = dict(original)
        previous = stitched[-1] if stitched else None
        if (previous and previous['chunk'] != event['chunk']
                and previous['continues_into_context'] and event['continued_from_context']
                and previous['midi_pitch'] == event['midi_pitch']
                and abs(previous['source_end_seconds'] - event['source_start_seconds']) <= 1e-6):
            previous['source_end_seconds'] = event['source_end_seconds']
            previous['end_seconds'] = event['source_end_seconds']
            previous.setdefault('stitched_chunks', [previous['chunk']]).append(event['chunk'])
            previous.setdefault('native_intervals', [[previous['raw_start_seconds'], previous['raw_end_seconds']]])
            previous['native_intervals'].append([event['raw_start_seconds'], event['raw_end_seconds']])
            previous['chunk'] = event['chunk']
            previous['continues_into_context'] = event['continues_into_context']
        else:
            stitched.append(event)
    return stitched


def _stop_process(process) -> None:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def refine_voicing(events, times, frequency, activation, rms):
    """Remove only sustained quiet, unvoiced spans from learned intervals.

    A missing pitch frame alone is not a rest. Short consonants/dropouts and
    loud spans without a reliable F0 remain owned by the learned note.
    """
    import numpy as np
    from .lead_note_proposal import runs
    times, frequency, activation, rms = [np.asarray(a) for a in (times, frequency, activation, rms)]
    if (times.ndim != 1 or len(times) < 2 or any(a.shape != times.shape for a in (frequency, activation, rms))
            or not np.all(np.isfinite(times)) or np.any(np.diff(times) <= 0)
            or not np.all(np.isfinite(rms)) or np.any(rms < 0)):
        raise ValueError('Invalid phoneme voicing evidence')
    hop = float(np.median(np.diff(times)))
    voiced = np.isfinite(frequency) & (frequency > 0) & (activation >= .03)
    output, edits = [], []
    for original in events:
        a, b = original['source_start_seconds'], original['source_end_seconds']
        indices = np.flatnonzero((times >= a) & (times < b))
        supported = indices[voiced[indices]]
        if len(supported) < 5:
            output.append(dict(original))
            continue
        reference = float(np.quantile(rms[supported], .75))
        quiet = (~voiced[indices]) & (rms[indices] <= reference * .15)
        cuts = [(max(a, float(times[indices[left]])), min(b, float(times[indices[right - 1]] + hop)))
                for left, right, value in runs(quiet) if value and (right - left) * hop >= .18]
        if not cuts:
            output.append(dict(original))
            continue
        pieces, cursor = [], a
        for left, right in cuts:
            if left - cursor > .03:
                pieces.append((cursor, min(b, left + .03)))
            cursor = max(cursor, right - .03)
        if b - cursor > .03:
            pieces.append((cursor, b))
        accepted = []
        for left, right in pieces:
            mask = (times >= left) & (times < right) & voiced
            if np.count_nonzero(mask) * hop < .06:
                continue
            pitches = 69 + 12 * np.log2(frequency[mask] / 440.)
            weights = activation[mask]
            order = np.argsort(pitches)
            median = pitches[order[np.searchsorted(np.cumsum(weights[order]), weights.sum() / 2)]]
            note = dict(original, source_start_seconds=round(left, 6), source_end_seconds=round(right, 6),
                        start_seconds=round(left, 6), end_seconds=round(right, 6), midi_pitch=int(round(median)))
            accepted.append(note)
        output.extend(accepted)
        edits.append({'sourceEvent': dict(original), 'quietUnvoicedSpans': cuts, 'resultEvents': accepted})
    return output, {'version': 'phoneme-quiet-breath-1', 'edits': edits,
                    'minimumQuietUnvoicedSeconds': .18, 'boundaryPaddingSeconds': .03,
                    'claimsPitchTruth': False}


def refine_voicing_from_files(events, audio, contour):
    import numpy as np
    import soundfile as sf
    signal, sr = sf.read(audio, dtype='float32', always_2d=True)
    signal = signal.mean(axis=1)
    times, frequency, activation = _load_contour(Path(contour), len(signal) / sr)
    center = np.minimum(len(signal) - 1, np.rint(times * sr).astype(int))
    half = max(1, round(.015 * sr))
    left, right = np.maximum(0, center - half), np.minimum(len(signal), center + half + 1)
    prefix = np.r_[0., np.cumsum(np.square(signal, dtype=np.float64))]
    rms = np.sqrt((prefix[right] - prefix[left]) / np.maximum(1, right - left))
    return refine_voicing(events, times, frequency, activation, rms)


def infer_phoneme(audio_path: str | Path, output_dir: str | Path, *, contour_path: str | Path,
                  timeout_seconds: float = 900., cancel_check=None) -> dict:
    """Return raw-time monophonic notes. Empty results are valid and explicit.

    ``contour_path`` must be real FCPE output from exactly ``audio_path`` on its
    complete zero-based timeline. Runtime is CPU-only and bounded to 300 seconds.
    Callers decide whether optional model failure/empty notes permits fallback.
    """
    if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
        raise ValueError('timeout_seconds must be finite and positive')
    if cancel_check and cancel_check():
        raise InterruptedError('Phoneme inference cancelled')
    health = runtime_health()
    if not health['ready']:
        raise RuntimeError(f'Phoneme runtime unavailable: {health}')
    import soundfile as sf
    audio = Path(audio_path).resolve()
    contour = Path(contour_path).resolve()
    info = sf.info(audio)
    duration = info.frames / info.samplerate
    if not math.isfinite(duration) or not 0 < duration <= MAX_SECONDS:
        raise ValueError(f'Phoneme input must be between 0 and {MAX_SECONDS:g} seconds')
    _load_contour(contour, duration)
    out = Path(output_dir).resolve()
    owned = [out / name for name in ('request.json', 'native.json', 'inference.log', 'failure.json', 'result.json', 'evidence')]
    if any(path == audio or path == contour or path.exists() or path.is_symlink() for path in owned):
        raise ValueError('Phoneme output must be fresh and cannot overwrite input or previous evidence')
    out.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    request = {'audio_path': str(audio), 'contour_path': str(contour), 'duration_seconds': duration,
               'audio_sha256': _file_digest(audio), 'contour_sha256': _file_digest(contour),
               'core_seconds': CORE_SECONDS, 'context_seconds': CONTEXT_SECONDS,
               'source_commit': SOURCE_COMMIT, 'checkpoint_sha256': MODEL_SHA256,
               'contour_identity': 'Caller-provided same-waveform FCPE; duration/timebase checked, identity not independently inferred'}
    (out / 'request.json').write_text(json.dumps(request, indent=2), encoding='utf-8')
    command = [str(RUNTIME / '.venv/bin/python'), str(ROOT / 'server/phoneme_runner.py'),
               '--request', str(out / 'request.json'), '--output', str(out)]
    env = os.environ | {'PYTHONPATH': str(ROOT), 'PYTHONNOUSERSITE': '1', 'PYTHONDONTWRITEBYTECODE': '1',
                        'OMP_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1', 'OPENBLAS_NUM_THREADS': '1',
                        'CUDA_VISIBLE_DEVICES': '', 'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1'}
    try:
        with (out / 'inference.log').open('w') as log:
            process = subprocess.Popen(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
            infer_started = time.monotonic()
            try:
                while process.poll() is None:
                    if cancel_check and cancel_check():
                        raise InterruptedError('Phoneme inference cancelled')
                    if time.monotonic() - infer_started > timeout_seconds:
                        raise TimeoutError('Phoneme inference timeout')
                    time.sleep(.2)
            finally:
                _stop_process(process)
        if process.returncode:
            raise RuntimeError(f"Phoneme inference failed ({process.returncode}); see {out / 'inference.log'}")
        native = json.loads((out / 'native.json').read_text())
        events = _validate_events(native['events'], duration)
        # Verify inputs and pinned runtime did not change while the child ran.
        if (_file_digest(audio) != request['audio_sha256'] or _file_digest(contour) != request['contour_sha256']
                or not runtime_health()['ready']):
            raise RuntimeError('Phoneme inputs or pinned runtime changed during inference')
        refined, voicing = refine_voicing_from_files(events, audio, contour)
        _validate_events(refined, duration)
        result = {**native, 'events': refined, 'nativeEvents': events, 'voicingRefinement': voicing,
                  'statistics': {**native.get('statistics', {}), 'native_voiced_notes': len(events), 'voiced_notes': len(refined)},
                  'engine': health['engine'], 'device': 'cpu',
                  'model': {'sourceCommit': SOURCE_COMMIT, 'checkpointSha256': MODEL_SHA256,
                            'pitchSource': 'same-waveform FCPE', 'pitchSummary': 'weighted_median'},
                  'duration_seconds': duration, 'elapsed_seconds': time.perf_counter() - started,
                  'artifact_path': str(out / 'result.json'), 'evidence_path': str(out / 'evidence'),
                  'request_path': str(out / 'request.json'), 'log_path': str(out / 'inference.log')}
        (out / 'result.json').write_text(json.dumps(result, indent=2, allow_nan=False), encoding='utf-8')
        return result
    except Exception as error:
        (out / 'failure.json').write_text(json.dumps({'success': False, 'errorType': type(error).__name__,
                                                     'message': str(error), 'log_path': str(out / 'inference.log')}, indent=2), encoding='utf-8')
        raise

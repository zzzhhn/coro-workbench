"""Optional isolated full-vocals separator; does not identify the lead singer."""
from __future__ import annotations
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / 'models/melband-roformer'
SOURCE_COMMIT = '25f44ffb55ee3c301281bba21b2d6d311cb69ae2'
CHECKPOINT_SHA256 = '87201f4d31afb5bc79993230fc49446918425574db48c01c405e44f365c7559e'
CONFIG_SHA256 = '87aabb300193b019159269b69d6fe5f313aae4201a22b4af6268bc2846ab2fe1'
_CACHE = {}


def _sha(path: Path) -> str:
    stat = path.stat()
    key = (str(path), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
    if key not in _CACHE:
        with path.open('rb') as stream:
            _CACHE[key] = hashlib.file_digest(stream, 'sha256').hexdigest()
    return _CACHE[key]


def runtime_health() -> dict:
    expected = {RUNTIME/'MelBandRoformer.ckpt': CHECKPOINT_SHA256,
                RUNTIME/'source/configs/config_vocals_mel_band_roformer.yaml': CONFIG_SHA256}
    required = [RUNTIME/'.venv/bin/python', RUNTIME/'source/models/mel_band_roformer/mel_band_roformer.py',
                RUNTIME/'source/utils.py', ROOT/'server/melband_runner.py', *expected]
    missing = [str(p) for p in required if not p.is_file()]
    errors = [f'Integrity mismatch: {p.name}' for p, digest in expected.items() if p.is_file() and _sha(p) != digest]
    validation = None
    try:
        validation = json.loads((RUNTIME/'validation.json').read_text())
    except (OSError, ValueError):
        pass
    return {'ready': not missing and not errors, 'engine': 'Mel-Band-RoFormer Kimberley Jensen full vocals',
            'missing': missing, 'integrityErrors': errors, 'sourceCommit': SOURCE_COMMIT,
            'checkpointSha256': CHECKPOINT_SHA256, 'defaultDevice': 'auto (MPS when available, CPU fallback)',
            'localValidation': validation, 'requiresNetwork': False,
            'limitations': 'Full vocals may retain backing/harmonies; no lead identity guarantee.'}


def _stop(process) -> None:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def separate_vocals(audio_path: Path, output: Path, *, cancel_check=None,
                    timeout_seconds: float = 1800., device: str = 'auto') -> dict:
    """Preserve source time, input sample count/rate, and unclipped FLOAT outputs.

    The isolated process accepts mono/stereo local audio. Other rates are resampled
    for the model and restored to the source rate; no timing/grid/pitch edits.
    """
    import soundfile as sf
    if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
        raise ValueError('timeout_seconds must be finite and positive')
    if device not in ('auto', 'mps', 'cpu'):
        raise ValueError('device must be auto, mps, or cpu')
    audio_path, output = Path(audio_path).resolve(), Path(output).resolve()
    destinations = [output/name for name in ('vocals.wav','instrumental.wav','separation.json','inference.log')]
    if any(p.resolve() == audio_path or (p.exists() and p.samefile(audio_path)) for p in destinations):
        raise ValueError('MelBand output would overwrite the source audio')
    info = sf.info(audio_path)
    if info.frames <= 0 or info.channels not in (1, 2):
        raise ValueError('Nonempty mono/stereo audio required')
    if cancel_check and cancel_check():
        raise InterruptedError('MelBand cancelled')
    health = runtime_health()
    if not health['ready']:
        raise RuntimeError(f'Pinned MelBand runtime unavailable: {health}')
    before = _sha(audio_path)
    output.mkdir(parents=True, exist_ok=True)
    command = [str(RUNTIME/'.venv/bin/python'), str(ROOT/'server/melband_runner.py'),
               '--audio',str(audio_path),'--output',str(output),'--runtime',str(RUNTIME),'--device',device]
    env = os.environ | {'PYTORCH_ENABLE_MPS_FALLBACK':'1','MELBAND_THREADS':'4'}
    with (output/'inference.log').open('w') as log:
        process = subprocess.Popen(command, cwd=RUNTIME/'source', env=env, stdout=log, stderr=subprocess.STDOUT)
        started = time.monotonic()
        try:
            while process.poll() is None:
                if cancel_check and cancel_check():
                    raise InterruptedError('MelBand cancelled')
                if time.monotonic()-started > timeout_seconds:
                    raise TimeoutError('MelBand timeout')
                time.sleep(.1)
        finally:
            _stop(process)
    if process.returncode:
        raise RuntimeError(f'MelBand failed ({process.returncode}); see {output/"inference.log"}')
    if _sha(audio_path) != before:
        raise RuntimeError('Source audio changed during separation')
    report = json.loads((output/'separation.json').read_text())
    if report.get('input',{}).get('sha256') != before:
        raise RuntimeError('MelBand source provenance mismatch')
    for name in ('vocals','instrumental'):
        path = output/(name+'.wav')
        result = sf.info(path)
        if result.frames != info.frames or result.samplerate != info.samplerate or result.channels != info.channels or result.subtype != 'FLOAT':
            raise RuntimeError('MelBand output timing/format mismatch')
    report.update({'vocalsPath':str(output/'vocals.wav'),'instrumentalPath':str(output/'instrumental.wav'),
                   'vocals_path':str(output/'vocals.wav'),'instrumental_path':str(output/'instrumental.wav'),
                   'paths':{'vocals':str(output/'vocals.wav'),'instrumental':str(output/'instrumental.wav')},
                   'checkpointSha256':CHECKPOINT_SHA256,'sourceCommit':SOURCE_COMMIT,
                   'sourceChanged':False,'runtimeSeconds':round(time.monotonic()-started,4)})
    (output/'separation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    return report

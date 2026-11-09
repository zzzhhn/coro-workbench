"""Bounded, offline CREPE pass over automatically selected lead disagreements."""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path
import time

from .multi_vocal import vocal_consensus_windows
from .phoneme import _load_contour, _validate_events

SAMPLE_RATE = 16000
HOP = 320


def _events(path: Path) -> list[dict]:
    data = json.loads(path.read_text())
    rows = data.get('events') if isinstance(data, dict) else data
    if not isinstance(rows, list):
        raise ValueError(f'Expected events in {path.name}')
    return rows


def _sha256(path: Path) -> str:
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def main() -> None:
    import librosa
    import numpy as np
    import soundfile as sf
    import torch
    import torchcrepe

    parser = argparse.ArgumentParser(description=__doc__)
    for field in ('audio', 'fcpe', 'native', 'learned', 'output'):
        parser.add_argument(f'--{field}', type=Path, required=True)
    args = parser.parse_args()
    torch.set_num_threads(4)
    started = time.monotonic()
    args.output.mkdir(parents=True, exist_ok=True)
    output, report = (args.output / name for name in ('contours.npz', 'report.json'))
    if any(path.exists() or path.is_symlink() for path in (output, report)):
        raise ValueError('Vocal consensus output must be fresh')
    duration = sf.info(args.audio).duration
    times, fcpe, activation = _load_contour(args.fcpe, duration)
    learned = _validate_events(_events(args.learned), duration)
    native = [n for n in _events(args.native) if n.get('program', 100) == 100 and not n.get('isDrum', False)]
    windows = vocal_consensus_windows(learned, native, times, fcpe, activation, duration)
    recordings = []
    for index, (left, right) in enumerate(windows):
        with sf.SoundFile(args.audio) as waveform:
            source_rate = waveform.samplerate
            begin, end = math.floor(left * source_rate), math.ceil(right * source_rate)
            waveform.seek(begin)
            mono = waveform.read(end - begin, dtype='float32', always_2d=True).mean(axis=1)
        if source_rate != SAMPLE_RATE:
            mono = librosa.resample(mono, orig_sr=source_rate, target_sr=SAMPLE_RATE)
        mono /= max(1., float(np.max(np.abs(mono))))
        with torch.inference_mode():
            pitch, period = torchcrepe.predict(
                torch.from_numpy(mono)[None], SAMPLE_RATE, HOP, 55, 1100, 'full',
                batch_size=128, device='cpu', return_periodicity=True, pad=True,
            )
        raw_time = begin / source_rate + np.arange(pitch.shape[-1]) * HOP / SAMPLE_RATE
        keep = (raw_time >= left - .0001) & (raw_time < right)
        recordings.append((raw_time[keep], pitch.numpy().reshape(-1)[keep], period.numpy().reshape(-1)[keep],
                           np.full(int(np.sum(keep)), index)))
        print(f'{index + 1}/{len(windows)} {left:.3f}–{right:.3f}s', flush=True)
    if recordings:
        raw_time, pitch, period, index = map(np.concatenate, zip(*recordings))
    else:
        raw_time, pitch, period, index = (np.array([]) for _ in range(4))
    np.savez_compressed(output, time=raw_time, crepeF0=pitch, periodicity=period, window=index,
                        fcpeF0=np.interp(raw_time, times, fcpe), fcpeActivation=np.interp(raw_time, times, activation))
    weights = Path(torchcrepe.__file__).parent / 'assets/full.pth'
    manifest = {
        'status': 'success' if windows else 'no_disputes', 'waveformDurationSeconds': duration,
        'windowsSeconds': windows, 'processedSeconds': sum(right - left for left, right in windows),
        'wallSeconds': time.monotonic() - started, 'maximumAudioSeconds': 60,
        'method': 'CREPE full Viterbi, 20ms, 55–1100Hz, CPU/4 threads/batch128',
        'versions': {name: importlib.metadata.version(name) for name in ('torchcrepe', 'torch', 'librosa', 'numpy', 'soundfile')},
        'inputSha256': {name: _sha256(path) for name, path in [('audio', args.audio), ('fcpe', args.fcpe),
                        ('native', args.native), ('learned', args.learned), ('crepeWeights', weights)]},
        'contourSha256': _sha256(output), 'claimsWholeSongPitchTruth': False,
    }
    report.write_text(json.dumps(manifest, indent=2) + '\n')


if __name__ == '__main__':
    main()

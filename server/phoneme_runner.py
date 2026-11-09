"""CPU-only child process for the pinned official phoneme-informed model.

Only main/run imports ML libraries. Raw logits and aligned real FCPE frequencies
are saved per bounded chunk; model sigmoid outputs are not calibrated confidence.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server import phoneme


def _chunk_windows(frames: int, sample_rate: int) -> list[dict]:
    if frames <= 0 or sample_rate <= 0 or frames / sample_rate > phoneme.MAX_SECONDS:
        raise ValueError('Invalid or over-limit phoneme audio length')
    core = round(phoneme.CORE_SECONDS * sample_rate)
    context = round(phoneme.CONTEXT_SECONDS * sample_rate)
    return [{'chunk': index, 'left': max(0, a - context), 'right': min(frames, a + core + context),
             'core_left': a, 'core_right': min(frames, a + core)}
            for index, a in enumerate(range(0, frames, core))]


def _events_from_decoded(pitches, intervals, *, hop_seconds: float, window: dict,
                         sample_rate: int) -> tuple[list[dict], int]:
    """Preserve native frame timing; omit only official unpitched sentinel 0."""
    if len(pitches) != len(intervals):
        raise ValueError('Official decoder returned unequal pitch/interval counts')
    events, unpitched = [], 0
    left = window['left'] / sample_rate
    right = window['right'] / sample_rate
    core_a, core_b = window['core_left'] / sample_rate, window['core_right'] / sample_rate
    for pitch, interval in zip(pitches, intervals):
        pitch = float(pitch)
        if pitch == 0:
            unpitched += 1
            continue
        if not math.isfinite(pitch) or not 1 <= round(pitch) <= 127:
            raise ValueError('Official decoder returned invalid MIDI pitch')
        if len(interval) != 2:
            raise ValueError('Official decoder returned malformed frame interval')
        a, b = map(float, interval)
        if not all(math.isfinite(value) for value in (a, b)) or not 0 <= a < b:
            raise ValueError('Official decoder returned invalid frame interval')
        raw_a, raw_b = left + a * hop_seconds, min(right, left + b * hop_seconds)
        start, end = max(core_a, raw_a), min(core_b, raw_b)
        if end - start <= 1e-6:
            continue
        events.append({'source_start_seconds': start, 'source_end_seconds': end,
                       'start_seconds': start, 'end_seconds': end, 'midi_pitch': int(round(pitch)),
                       'raw_midi_pitch': pitch, 'raw_start_seconds': raw_a, 'raw_end_seconds': raw_b,
                       'rest': False, 'chunk': window['chunk'],
                       'continued_from_context': raw_a < core_a - 1e-6,
                       'continues_into_context': raw_b > core_b + 1e-6})
    return events, unpitched


def run(request_path: Path, output: Path) -> dict:
    # Import only in the isolated runtime. No hub loader or network operation.
    import importlib.metadata
    import librosa
    import numpy as np
    import soundfile as sf
    import torch
    from server.vocal_groundtruth import resample_f0_track

    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    request = json.loads(request_path.read_text())
    health = phoneme.runtime_health()
    if not health['ready']:
        raise RuntimeError(f'Phoneme runtime integrity check failed: {health}')
    sys.path.insert(0, str(phoneme.RUNTIME / 'source'))
    from phn_ast.model import TranscriptionModel
    from phn_ast.decoding import FramewiseDecoder

    checkpoint = torch.load(phoneme.RUNTIME / 'model.pt', map_location='cpu', weights_only=True)
    config = checkpoint['config']
    sample_rate = int(config['sample_rate'])
    hop_seconds = int(config['hop_length']) / sample_rate
    model = TranscriptionModel(config).to('cpu').eval()
    model.load_state_dict(checkpoint['model_state_dict'])
    decoder = FramewiseDecoder(config)
    decoder.pitch_sum = 'weighted_median'

    audio_path, contour_path = Path(request['audio_path']), Path(request['contour_path'])
    if (phoneme._file_digest(audio_path) != request['audio_sha256']
            or phoneme._file_digest(contour_path) != request['contour_sha256']):
        raise RuntimeError('Phoneme input changed before child inference')
    audio, original_sr = sf.read(audio_path, dtype='float32', always_2d=True)
    audio = audio.mean(axis=1)
    duration = len(audio) / original_sr
    if abs(duration - request['duration_seconds']) > 1e-6:
        raise ValueError('Phoneme request duration does not match waveform')
    times, frequency, activation = phoneme._load_contour(contour_path, duration)
    if original_sr != sample_rate:
        audio = librosa.resample(audio, orig_sr=original_sr, target_sr=sample_rate)
    if not np.all(np.isfinite(audio)):
        raise ValueError('Phoneme input contains nonfinite audio samples')
    audio = (audio / max(1., float(np.max(np.abs(audio))))).astype(np.float32)
    evidence = output / 'evidence'
    evidence.mkdir(exist_ok=False)
    all_events, chunks, total_unpitched = [], [], 0
    windows = _chunk_windows(len(audio), sample_rate)
    for window in windows:
        waveform = torch.from_numpy(audio[window['left']:window['right']])[None]
        with torch.inference_mode():
            predictions = model(waveform)
            if predictions.ndim != 3 or predictions.shape[0] != 1 or predictions.shape[2] != 3:
                raise ValueError('Official phoneme model returned unexpected frame output shape')
            query = window['left'] / sample_rate + np.arange(predictions.shape[1]) * hop_seconds
            f0, voiced = resample_f0_track(times, frequency, query, voicing=activation >= .03)
            f0[~voiced] = np.nan
            pitches, intervals = decoder.decode(predictions, f0=torch.from_numpy(f0))
        events, unpitched = _events_from_decoded(pitches, intervals, hop_seconds=hop_seconds,
                                                window=window, sample_rate=sample_rate)
        all_events.extend(events)
        total_unpitched += unpitched
        artifact = evidence / f"chunk-{window['chunk']:04d}.npz"
        np.savez_compressed(artifact, source_time=query, raw_logits=predictions.cpu().numpy(),
                            fcpe_f0=f0, fcpe_voiced=voiced)
        chunks.append({**window, 'sample_rate': sample_rate, 'frames': int(predictions.shape[1]),
                       'events': events, 'filtered_unpitched_notes': unpitched,
                       'decoded_notes': len(pitches), 'evidence_path': str(artifact)})
        print(f"Phoneme chunk {window['chunk']}: {len(events)} owned notes, {unpitched} unpitched", flush=True)
    events = phoneme._stitch_context_events(all_events)
    # Resampling ceil rounding may extend the last chunk by under one sample.
    for event in events:
        event['source_end_seconds'] = min(event['source_end_seconds'], duration)
        event['end_seconds'] = event['source_end_seconds']
    phoneme._validate_events(events, duration)
    result = {'success': True, 'events': events, 'chunks': chunks,
              'filtered_unpitched_notes': total_unpitched,
              'statistics': {'voiced_notes': len(events), 'chunks': len(chunks),
                             'filtered_unpitched_notes': total_unpitched},
              'chunk_seconds': phoneme.CORE_SECONDS, 'context_seconds': phoneme.CONTEXT_SECONDS,
              'cpu_threads': 1, 'pitch_summary': 'weighted_median',
              'versions': {name: importlib.metadata.version(name) for name in
                           ('torch', 'torchaudio', 'nnAudio', 'wquantiles', 'librosa', 'numpy')},
              'evidence_kind': 'Official raw boundary/activation logits and same-waveform FCPE F0; no calibrated note probability',
              'limitations': 'Optional phoneme-informed model; checkpoint training overlap is possible. Chunk context can miss long continuations; empty notes are explicit.'}
    (output / 'native.json').write_text(json.dumps(result, indent=2, allow_nan=False), encoding='utf-8')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        run(args.request, args.output)
    except Exception as error:
        (args.output / 'failure.json').write_text(json.dumps({'success': False,
            'errorType': type(error).__name__, 'message': str(error), 'stage': 'isolated phoneme model'}), encoding='utf-8')
        raise


if __name__ == '__main__':
    main()

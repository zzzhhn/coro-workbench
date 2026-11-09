#!/usr/bin/env python3
"""Optional research comparator: official phoneme boundaries + frozen FCPE pitch.

This never changes production defaults. Run infer before score; all audio, frame
predictions and note labels stay in ignored data/. No downloads during inference.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('p0', ROOT / 'scripts/benchmark-vocal-p0.py')
p0 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p0)
MODEL_ROOT = ROOT / 'models/phoneme-ast'
MODEL_HASH = 'e56d1c7438f10afb61bbfe54a856a0355d4556fca6038dc67567fe68930ade17'
SOURCE_COMMIT = 'b2fcd9ea0f7898a8989c7e65781052d1ffc81094'


def frozen_dependencies():
    import subprocess
    source = MODEL_ROOT / 'source'
    commit = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    if commit != SOURCE_COMMIT or p0.sha256(MODEL_ROOT / 'model.pt') != MODEL_HASH:
        raise ValueError('Expected official source commit and Git LFS checkpoint hash')
    paths = [Path(__file__), MODEL_ROOT / 'model.pt', *sorted((source / 'phn_ast').glob('*.py'))]
    return {str(path): p0.sha256(path) for path in paths}


def infer(run_name, baseline):
    import numpy as np
    import torch
    import librosa
    from server.quality_runner import mono_audio
    from server.vocal_groundtruth import resample_f0_track
    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    base = p0.PRIVATE / 'runs' / baseline
    p0.verify_frozen(p0.PRIVATE, base)
    before = frozen_dependencies()
    source = MODEL_ROOT / 'source'
    sys.path.insert(0, str(source))
    from phn_ast.model import TranscriptionModel
    from phn_ast.decoding import FramewiseDecoder
    checkpoint = torch.load(MODEL_ROOT / 'model.pt', map_location='cpu', weights_only=True)
    config = checkpoint['config']
    model = TranscriptionModel(config).eval()
    model.load_state_dict(checkpoint['model_state_dict'])
    decoder = FramewiseDecoder(config)
    decoder.pitch_sum = 'weighted_median'
    run = p0.PRIVATE / 'runs' / run_name
    run.mkdir(exist_ok=False)
    plan = {'method': 'Official phoneme-informed boundaries + existing FCPE pitch; hybrid research comparator',
            'source': 'https://github.com/seyong92/phoneme-informed-note-level-singing-transcription',
            'sourceCommit': SOURCE_COMMIT, 'dependencies': before, 'referenceRead': False,
            'baseline': baseline, 'baselineFrozenSha256': p0.sha256(base / 'frozen.json'),
            'config': config, 'pitchSummary': decoder.pitch_sum, 'cpuThreads': 1,
            'limits': 'SSVD training overlap possible; diagnostic only, not a blinded model ranking',
            'versions': {name: p0.importlib.metadata.version(name) for name in ('torch', 'torchaudio', 'nnAudio', 'wquantiles', 'librosa')}}
    p0.write_once(run / 'inference-plan.json', plan)
    baseline_predictions = p0.read_json(base / 'predictions.json')['tracks']
    predictions = {}
    for identifier in p0.IDS:
        started = time.perf_counter()
        audio, sr = mono_audio(p0.PRIVATE / 'dataset' / f'{identifier}.flac', config['sample_rate'])
        waveform = torch.from_numpy(audio)[None]
        with torch.inference_mode():
            frame_predictions = model(waveform)
            query_times = np.arange(frame_predictions.shape[1]) * config['hop_length'] / sr
            with np.load(base / f'{identifier}-fcpe.npz', allow_pickle=False) as contour:
                frequency, voiced = resample_f0_track(contour['time'], contour['f0'], query_times,
                                                     voicing=(contour['activation'] >= .03))
            frequency[~voiced] = np.nan
            pitches, intervals = decoder.decode(frame_predictions, f0=torch.from_numpy(frequency))
        hop = config['hop_length'] / sr
        duration = len(audio) / sr
        events = [[float(a * hop), min(float(b * hop), duration), int(round(pitch)), .75]
                  for pitch, (a, b) in zip(pitches, intervals)
                  if np.isfinite(pitch) and 0 < pitch <= 127 and a * hop < duration and b > a]
        grid = baseline_predictions[identifier]['grid']
        variants = p0.quantized_variants(events, grid, duration)
        np.savez_compressed(run / f'{identifier}-boundaries.npz', time=query_times,
                            prediction=frame_predictions.numpy(), f0=frequency)
        predictions[identifier] = {'events': events, 'variants': variants,
                                  'filteredUnpitchedNotes': len(pitches) - len(events),
                                  'runtimeSeconds': time.perf_counter() - started}
        print(f"Phoneme {identifier}: {len(events)} notes, {predictions[identifier]['runtimeSeconds']:.2f}s", flush=True)
    if frozen_dependencies() != before:
        raise ValueError('Source or model changed during inference')
    p0.write_once(run / 'predictions.json', predictions)
    p0.write_once(run / 'frozen.json', {'dependencies': before, 'baseline': baseline,
                   'baselineFrozenSha256': plan['baselineFrozenSha256'], 'referenceRead': False,
                   'artifacts': {path.name: p0.sha256(path) for path in run.iterdir() if path.is_file()}})


def infer_runtime(run_name, baseline):
    """Evaluate the actual subprocess/chunk/stitch adapter, not the prototype."""
    from server.phoneme import infer_phoneme, runtime_health
    health = runtime_health()
    if not health['ready']:
        raise ValueError(f'Install the optional runtime first: {health}')
    base = p0.PRIVATE / 'runs' / baseline
    p0.verify_frozen(p0.PRIVATE, base)
    before = frozen_dependencies()
    run = p0.PRIVATE / 'runs' / run_name
    run.mkdir(exist_ok=False)
    plan = {'method': 'Production phoneme subprocess, 20s cores + 1s context, FCPE pitch',
            'source': 'https://github.com/seyong92/phoneme-informed-note-level-singing-transcription',
            'sourceCommit': SOURCE_COMMIT, 'dependencies': before, 'referenceRead': False,
            'baseline': baseline, 'baselineFrozenSha256': p0.sha256(base / 'frozen.json'),
            'runtime': health, 'cpuThreads': 1,
            'limits': 'Clean singing regression; training overlap unknown; not a mixed-song ranking'}
    p0.write_once(run / 'inference-plan.json', plan)
    baseline_predictions = p0.read_json(base / 'predictions.json')['tracks']
    predictions = {}
    for identifier in p0.IDS:
        result = infer_phoneme(p0.PRIVATE / 'dataset' / f'{identifier}.flac', run / identifier,
                               contour_path=base / f'{identifier}-fcpe.npz')
        events = [[e['source_start_seconds'], e['source_end_seconds'], e['midi_pitch'], .75]
                  for e in result['events']]
        predictions[identifier] = {'events': events,
            'variants': p0.quantized_variants(events, baseline_predictions[identifier]['grid'], result['duration_seconds']),
            'filteredUnpitchedNotes': result['filtered_unpitched_notes'],
            'runtimeSeconds': result['elapsed_seconds'], 'chunks': result['statistics']['chunks']}
        print(f"Runtime {identifier}: {len(events)} notes, {result['elapsed_seconds']:.2f}s", flush=True)
    if frozen_dependencies() != before:
        raise ValueError('Source or model changed during inference')
    p0.verify_frozen(p0.PRIVATE, base)
    p0.write_once(run / 'predictions.json', predictions)
    p0.write_once(run / 'frozen.json', {'dependencies': before, 'baseline': baseline,
        'baselineFrozenSha256': plan['baselineFrozenSha256'], 'referenceRead': False,
        'artifacts': {str(path.relative_to(run)): p0.sha256(path) for path in run.rglob('*') if path.is_file()}})


def score(run_name):
    import numpy as np
    from server.vocal_groundtruth import note_metrics
    run = p0.PRIVATE / 'runs' / run_name
    frozen = p0.read_json(run / 'frozen.json')
    p0.verify_files(Path('/'), frozen['dependencies'])
    p0.verify_files(run, frozen['artifacts'])
    base = p0.PRIVATE / 'runs' / frozen['baseline']
    if p0.sha256(base / 'frozen.json') != frozen['baselineFrozenSha256']:
        raise ValueError('Frozen baseline changed')
    p0.verify_frozen(p0.PRIVATE, base)
    manifest = p0.read_json(p0.PRIVATE / 'dataset-manifest.json')
    p0.verify_files(p0.PRIVATE / 'dataset', {name: item['sha256'] for name, item in manifest['files'].items()})
    predictions = p0.read_json(run / 'predictions.json')
    report, grouped = {'perTrack': {}, 'aggregate': {}}, {}
    for identifier in p0.IDS:
        reference = p0.parse_reference(p0.PRIVATE / 'dataset' / f'{identifier}.txt')
        report['perTrack'][identifier] = {}
        for variant, output in predictions[identifier]['variants'].items():
            events = np.asarray(output['events'], dtype=float)
            estimate = events[:, :3].copy() if events.size else np.empty((0, 3))
            estimate[:, 2] = 440 * 2 ** ((estimate[:, 2] - 69) / 12)
            report['perTrack'][identifier][variant] = {}
            for mode, offset in [('onsetPitch', False), ('onsetOffsetPitch', True)]:
                result = note_metrics(reference, estimate, require_offset=offset)
                result.pop('matchedPairs')
                report['perTrack'][identifier][variant][mode] = result
                grouped.setdefault((variant, mode), []).append(result)
    for (variant, mode), rows in grouped.items():
        report['aggregate'].setdefault(variant, {})[mode] = p0.aggregate_metrics(rows)
    p0.write_once(run / 'scores.json', report)
    print(json.dumps(report['aggregate'], indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('stage', choices=['infer', 'score'])
    parser.add_argument('--run', default='phoneme-v1')
    parser.add_argument('--baseline', default='baseline-v1')
    parser.add_argument('--split', choices=['diagnostic', 'validation'], default='diagnostic')
    parser.add_argument('--runtime', action='store_true', help='Use the actual isolated production adapter')
    args = parser.parse_args()
    if any(not p0.re.fullmatch(r'[a-zA-Z0-9_-]+', name) for name in (args.run, args.baseline)):
        parser.error('run and baseline must be simple identifiers')
    p0.configure_split(args.split)
    if args.stage == 'infer':
        (infer_runtime if args.runtime else infer)(args.run, args.baseline)
    else:
        score(args.run)

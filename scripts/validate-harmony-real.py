"""Bounded, reproducible saved-stem experiment. No song chord truth is assumed."""
from __future__ import annotations

import json
import sys
import time
from collections import Counter
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from server.harmony import VERSION, extract_acoustic_features, file_sha256, infer_audio_harmony

JOBS = [
    ('Ariana - bye', 'f70ebab316d54d62abb0f56d19e0356e'),
    ('NewJeans - Attention', '22d62c8049d04e39b9062b60513bf9c5'),
    ('Weeknd - Out of Time', '1eac4381bbfd4904a66bf0ca97e2f72d'),
    ('单依纯 - 空耳', 'a6be0eb965d048a0ad57819135164463'),
]
SLICES = [('development', 0., 32.), ('temporal-heldout', 110., 140.)]
CONFIGS = {'instruments-bass': ('piano', 'guitar', 'bass'), 'with-other': ('piano', 'guitar', 'bass', 'other')}


def excerpt(segment):
    return {key: segment[key] for key in ('sourceStartSeconds', 'sourceEndSeconds', 'symbol', 'status', 'fitMargin', 'evidence')} | {'top3': [{key: value[key] for key in ('symbol', 'score', 'fit', 'missingToneEvidence', 'bassSupport')} for value in segment['candidates'][:3]]}


def summarize(result, project):
    segments = result['segments']
    counts = Counter(segment['status'] for segment in segments)
    # Compare existing symbolic draft only as an edit-size diagnostic, never truth.
    old_differences = 0
    overlap = 0
    for segment in segments:
        midpoint = segment['start'] + segment['duration'] / 2
        old = next((chord for chord in project.get('chords', []) if chord['start'] <= midpoint < chord['start'] + chord['duration']), None)
        if old:
            overlap += 1
            old_differences += old['symbol'] != segment['symbol']
    changes = sum(a['symbol'] != b['symbol'] for a, b in zip(segments, segments[1:]))
    span = segments[-1]['sourceEndSeconds'] - segments[0]['sourceStartSeconds'] if segments else 0
    return {'windows': len(segments), 'statusCounts': dict(counts), 'symbolCounts': dict(Counter(segment['symbol'] for segment in segments)), 'labelChanges': changes, 'changesPerMinute': round(changes * 60 / span, 3) if span else 0, 'medianTop2FitMargin': round(float(np.median([segment['fitMargin'] for segment in segments])), 6), 'existingDraftOverlappingWindows': overlap, 'existingDraftDifferentSymbols': old_differences, 'existingDraftComparisonMeaning': 'edit-size/stability diagnostic only, not accuracy', 'mostAmbiguousExamples': [excerpt(s) for s in sorted(segments, key=lambda s: s['fitMargin'])[:3]]}


def main():
    started = time.monotonic()
    rows, comparisons = [], []
    initial_hashes = {}
    for name, job in JOBS:
        directory = ROOT / 'data' / job
        status_path = directory / 'status.json'
        initial_hashes[str(status_path)] = file_sha256(status_path)
        project = json.loads(status_path.read_text())['project']
        audio = project['originalAudio']
        bpm, offset = float(audio['tempo']), float(audio.get('offsetSeconds', 0))
        for split, start, end in SLICES:
            results = {}
            for config, names in CONFIGS.items():
                local_start = time.monotonic()
                output = ROOT / 'data/phase3/harmony-real' / job / split / config
                stems = {stem: directory / f'stem-{stem}.wav' for stem in names}
                for path in stems.values():
                    initial_hashes.setdefault(str(path), file_sha256(path))
                features = extract_acoustic_features(stems, start, end, output)
                assert np.isfinite(features.spectrum).all() and np.isfinite(features.bass_spectrum).all()
                assert features.times.min() >= start and features.times.max() <= end + .02
                result = infer_audio_harmony(features, bpm, offset, output=output)
                # Independently calculate physical mapping from emitted beat coordinates.
                errors = [max(abs(offset + s['start'] * 60 / bpm - s['sourceStartSeconds']), abs(offset + (s['start'] + s['duration']) * 60 / bpm - s['sourceEndSeconds'])) for s in result['segments']]
                assert max(errors, default=0) < 2e-6
                assert all(start <= s['sourceStartSeconds'] < s['sourceEndSeconds'] <= end for s in result['segments'])
                row = {'song': name, 'job': job, 'split': split, 'sourceRangeSeconds': [start, end], 'config': config, 'bpm': bpm, 'offsetSeconds': offset, 'runtimeSeconds': round(time.monotonic() - local_start, 3), 'maxBeatToSourceErrorSeconds': max(errors, default=0), 'result': str(output / 'harmony-candidates.json'), 'rawFeatures': str(output / 'features.npz'), **summarize(result, project)}
                rows.append(row)
                results[config] = result
                print(json.dumps({key: row[key] for key in ('song', 'split', 'config', 'windows', 'statusCounts', 'runtimeSeconds')}, ensure_ascii=False), flush=True)
            left, right = (results[config]['segments'] for config in CONFIGS)
            assert len(left) == len(right)
            diffs = [(a, b) for a, b in zip(left, right) if a['symbol'] != b['symbol']]
            comparisons.append({'song': name, 'job': job, 'split': split, 'windows': len(left), 'changedByOtherStem': len(diffs), 'meaning': 'sensitivity to residual other stem, not either configuration accuracy', 'examples': [{'withoutOther': excerpt(a), 'withOther': excerpt(b)} for a, b in diffs[:4]]})
    mutations = [path for path, digest in initial_hashes.items() if file_sha256(Path(path)) != digest]
    assert not mutations, f'Input changed during experiment: {mutations}'
    report = {'version': VERSION, 'codeSha256': file_sha256(ROOT / 'server/harmony.py'), 'groundTruthAvailable': False, 'scope': '4 songs x 2 predeclared time slices x 2 fixed stem configurations; no neural inference, no key/decoded-note harmonic input. All accuracy claims limited to separately authored fixtures.', 'holdoutMeaning': '110–140 s never used for parameter tuning in this continuation; no manual chord annotation, so not song-accuracy evaluation.', 'rhythmMeaning': 'Frozen original job tempo/offset; 空耳 uses stored 64.998 BPM, not later score-only doubled-grid variants.', 'configs': CONFIGS, 'rows': rows, 'comparisons': comparisons, 'inputHashes': initial_hashes, 'inputsUnchangedAfterRun': True, 'runtimeSeconds': round(time.monotonic() - started, 3), 'recommendation': 'Do not promote either configuration to default. Offer reversible acoustic candidates with explicit apply, top-three alternatives, N/ambiguity and raw source-time evidence. More candidates or agreement with old draft do not establish correctness.'}
    target = ROOT / 'evidence/phase3/harmony-real.json'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()

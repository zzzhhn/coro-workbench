"""Build a private, reproducible three-stage review without rerunning AMT."""
from pathlib import Path
import copy
import hashlib
import json
import sys

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from server.vocal_notation import infer_vocal_notation, VERSION

OUT = ROOT / 'evidence/pipeline-ab-20261108'
SOURCE = ROOT / 'evidence/vocal-ab-20261107'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def stats(notes):
    gaps = [b['start'] - a['start'] - a['duration'] for a, b in zip(notes, notes[1:])]
    return {'notes': len(notes), 'shorterThanSixteenth': sum(n['duration'] < .25 for n in notes),
            'shorterThanThirtySecond': sum(n['duration'] < .125 for n in notes),
            'subSixteenthRests': sum(1e-6 < gap < .25 - 1e-6 for gap in gaps)}


def synth(notes, grid, duration, path):
    sr = 22050
    output = np.zeros(round((duration + 1) * sr), np.float32)
    spb = 60 / grid['bpm']
    for n in notes:
        start = max(0, round((grid['offsetSeconds'] + n['start'] * spb) * sr))
        length = min(round(n['duration'] * spb * sr), len(output) - start)
        if length < 1:
            continue
        t = np.arange(length) / sr
        freq = 440 * 2 ** ((n['midi'] - 69) / 12)
        env = np.minimum(1, t / .008) * np.minimum(1, (length / sr - t) / .025) * (.7 + .3 * np.exp(-t * 5))
        tone = sum(np.sin(2 * np.pi * freq * h * t) / h ** 2 for h in (1, 2, 3, 4))
        output[start:start + length] += np.asarray(.19 * env * tone, np.float32)
    sf.write(path, np.clip(output, -.95, .95), sr, subtype='PCM_16')


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    inputs = [SOURCE / 'large-20261108/game-medium-k8-phrases.json', SOURCE / 'review-data.json',
              ROOT / 'data/b2a027624334481cba7c56aab68bfda1/project.json']
    before = {str(p.relative_to(ROOT)): digest(p) for p in inputs}
    raw, previous, full = [json.loads(p.read_text()) for p in inputs]
    baseline = previous['variants']['game-medium-phrases']['project']
    baseline_notes = baseline['parts'][0]['notes']
    assert len(baseline_notes) == len(raw['events'])
    events = [dict(event, id=baseline_notes[i]['id']) for i, event in enumerate(raw['events'])]
    grid = previous['notationGrid']
    notes, audit = infer_vocal_notation(events, grid, raw['seconds'])
    candidate = copy.deepcopy(baseline)
    candidate['parts'][0]['notes'] = notes
    candidate['title'] = 'GAME Medium · 记谱语法候选'
    assert [n['midi'] for n in notes] == [e['midi'] for e in events]
    assert [n['id'] for n in notes] == [n['id'] for n in baseline_notes]
    windows = []
    for first in range(1, 71, 4):
        # Both experiment arms use the identical production clock. The leading
        # virtual bar is excluded from the author's displayed measure numbers.
        a, b = first * 4, (first + 4) * 4
        select = lambda ns: [n for n in ns if a <= n['start'] < b]
        shifts = [c for n, c in zip(notes, audit['changes']) if a <= n['start'] < b]
        windows.append({'firstBar': first, 'lastBar': min(70, first + 3),
                        'baseline': stats(select(baseline_notes)), 'candidate': stats(select(notes)),
                        'maximumOnsetShiftSeconds': max((abs(c['scoreStartSeconds'] - c['sourceStartSeconds']) for c in shifts), default=0)})
    identity = hashlib.sha256(json.dumps({'inputs': before, 'version': VERSION, 'notes': notes}, sort_keys=True).encode()).hexdigest()
    manifest = {'id': identity, 'version': 1, 'date': '2026-11-08', 'model': 'GAME Medium 8 steps',
                'duration': raw['seconds'], 'grid': grid, 'inputs': before,
                'baseline': baseline, 'candidate': candidate, 'ensembleSource': full,
                'audit': audit, 'windows': windows, 'summary': {'baseline': stats(baseline_notes), 'candidate': stats(notes)},
                'reviewPolicy': {'status': 'pending-human-review', 'automaticPromotion': False,
                                 'independentSongs': 1, 'directListeningByAgent': False,
                                 'fixedPitchAndEventCount': True, 'referenceUsedForInference': False},
                'originalUrl': 'http://127.0.0.1:8788/original.wav',
                'stemUrl': 'http://127.0.0.1:8788/vocals.wav',
                'rawUrl': 'http://127.0.0.1:8788/raw.wav',
                'baselineUrl': '/evidence/vocal-ab-20261107/playback/game-medium-phrases-score.wav',
                'candidateUrl': 'http://127.0.0.1:8788/candidate-score.wav'}
    # Use the same synthesizer for both arms; no timbre or loudness confound.
    synth(baseline_notes, grid, raw['seconds'], OUT / 'baseline-score.wav')
    synth(notes, grid, raw['seconds'], OUT / 'candidate-score.wav')
    manifest['baselineUrl'] = 'http://127.0.0.1:8788/baseline-score.wav'
    for p in inputs:
        assert digest(p) == before[str(p.relative_to(ROOT))]
    for name, value in [('review.json', manifest), ('audit.json', audit)]:
        temp = OUT / (name + '.tmp')
        temp.write_text(json.dumps(value, ensure_ascii=False))
        temp.replace(OUT / name)
    print(json.dumps({'id': identity[:12], 'summary': manifest['summary'],
                      'maximumOnsetShiftSeconds': max(abs(c['scoreStartSeconds'] - c['sourceStartSeconds']) for c in audit['changes']),
                      'maximumReleaseShiftSeconds': max(abs(c['scoreEndSeconds'] - c['sourceEndSeconds']) for c in audit['changes'])}, ensure_ascii=False))


if __name__ == '__main__':
    main()

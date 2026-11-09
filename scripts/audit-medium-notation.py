"""Compare frozen Medium events with both notation arms; never alter a score.

Timing changes are diagnostic, not error labels. Reference notes and lyrics are
deliberately not inputs to this audit, and no human preference is fabricated.
"""
from pathlib import Path
import hashlib
import json

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'evidence/pipeline-ab-20261108/feedback-lyrics'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def candidate_side(identifier, first_bar):
    value = 2166136261
    for char in f'{identifier}:vocal:{first_bar}':
        value = ((value ^ ord(char)) * 16777619) & 0xffffffff
    return 'A' if value % 2 else 'B'


def summarize(rows):
    return {
        'notes': len(rows),
        'onsetMovedOver50ms': sum(abs(r['onsetDeltaSeconds']) > .05 for r in rows),
        'maxAbsoluteOnsetDeltaSeconds': max((abs(r['onsetDeltaSeconds']) for r in rows), default=0),
        'maxAbsoluteReleaseDeltaSeconds': max((abs(r['releaseDeltaSeconds']) for r in rows), default=0),
        'maxAbsoluteDurationDeltaSeconds': max((abs(r['durationDeltaSeconds']) for r in rows), default=0),
    }


def main():
    review_path = ROOT / 'evidence/pipeline-ab-20261108/review.json'
    provenance_path = review_path.with_name('provenance.json')
    raw_path = ROOT / 'evidence/vocal-ab-20261107/large-20261108/game-medium-k8-phrases.json'
    paths = (review_path, provenance_path, raw_path)
    frozen = {str(p.relative_to(ROOT)): digest(p) for p in paths}
    review, provenance, raw = [json.loads(p.read_text()) for p in paths]
    assert review['id'] == provenance['candidateId']
    assert digest(raw_path) == provenance['inputs'][str(raw_path.relative_to(ROOT))]
    identifier = ':'.join((review['id'], provenance['versions']['strings'], provenance['versions']['layout']))
    spb, origin = 60 / review['grid']['bpm'], review['grid']['offsetSeconds']
    events = raw['events']
    arms = {}
    for arm in ('baseline', 'candidate'):
        notes = review[arm]['parts'][0]['notes']
        assert len(notes) == len(events)
        assert [n['midi'] for n in notes] == [e['midi'] for e in events]
        rows = []
        for event, note in zip(events, notes):
            start = origin + note['start'] * spb
            end = origin + (note['start'] + note['duration']) * spb
            rows.append({
                'id': note['id'], 'midi': note['midi'],
                'sourceStartSeconds': event['start'], 'sourceEndSeconds': event['end'],
                'scoreStartSeconds': start, 'scoreEndSeconds': end,
                'onsetDeltaSeconds': start - event['start'],
                'releaseDeltaSeconds': end - event['end'],
                'durationDeltaSeconds': end - start - (event['end'] - event['start']),
            })
        windows = []
        for first in range(1, 71, 4):
            start = origin + first * 4 * spb
            end = min(raw['seconds'], origin + (first + 4) * 4 * spb)
            # Window ownership follows RAW onsets, identical in both arms.
            selected = [r for r in rows if start <= r['sourceStartSeconds'] < end]
            windows.append({'firstBar': first, 'lastBar': min(70, first + 3),
                            'candidateSide': candidate_side(identifier, first),
                            **summarize(selected),
                            'largestDurationChanges': sorted(selected,
                                key=lambda r: abs(r['durationDeltaSeconds']), reverse=True)[:4]})
        arms[arm] = {'summary': summarize(rows), 'windows': windows, 'events': rows}
    for path in paths:
        assert digest(path) == frozen[str(path.relative_to(ROOT))]
    result = {'experimentId': identifier, 'inputs': frozen, 'grid': review['grid'],
              'rawEvents': len(events), 'arms': arms,
              'interpretation': 'Timing perturbation only; not accuracy, audibility, or human acceptance.',
              'rawAudioRounding': 'Legacy raw synthesis floors start samples; score synthesis rounds them. At 22050 Hz the difference is less than one sample.',
              'referenceUsedForInference': False, 'productionChanged': False}
    OUT.mkdir(parents=True, exist_ok=True)
    target = OUT / 'timing-audit.json'
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'output': str(target), 'summary': {k: v['summary'] for k, v in arms.items()}}, ensure_ascii=False))


if __name__ == '__main__':
    main()

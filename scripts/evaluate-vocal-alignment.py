"""Compare native and acoustically aligned notes on cached human references.

All predictions are generated before the scorer reads reference note files.
This is development regression evidence, not a newly blinded benchmark.
"""
from pathlib import Path
import argparse
import hashlib
import json
import sys

import mir_eval
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from server.vocal_alignment import align_vocal_notes
from server.vocal_groundtruth import load_reference_notes, note_metrics


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--split', choices=['pilot', 'remaining'], default='remaining')
    args = parser.parse_args()
    dataset = json.loads((ROOT / 'data/benchmarks/vocadito/manifest.json').read_text())
    pilot = args.split == 'pilot'
    ids = dataset['pilotIds'] if pilot else dataset['reservedIds']
    prediction_root = ROOT / ('data/phase6/rosvot/full-suite' if pilot else 'data/phase7/rosvot-32')
    contour_root = ROOT / ('data/phase4/vocadito-pilot/fcpe' if pilot else 'data/phase4/vocadito-holdout/fcpe')
    feature_root = ROOT / ('data/phase4/vocadito-decoders' if pilot else 'data/phase4/vocadito-holdout-decoders')
    output = ROOT / f'data/phase7/aligned-{args.split}'
    output.mkdir(exist_ok=True)
    predictions = {}
    edits = {}
    for identifier in ids:
        native = json.loads((prediction_root / f'vocadito_{identifier}.json').read_text())
        with np.load(contour_root / identifier / 'contour.npz') as contour, np.load(feature_root / identifier / 'acoustic-evidence.npz') as features:
            aligned, details = align_vocal_notes(native['events'], contour['time'], contour['f0'], contour['activation'], dict(features))
        assert [e['midi_pitch'] for e in aligned] == [e['midi_pitch'] for e in native['events']]
        (output / f'{identifier}.json').write_text(json.dumps({'events': aligned, 'alignment': details}))
        predictions[identifier] = {'native': native['events'], 'aligned': aligned}
        edits[identifier] = len(details['boundaryEdits'])
    rows, counts, crosschecks = [], {}, 0
    for identifier, versions in predictions.items():
        row = {'id': identifier, 'boundaryEdits': edits[identifier], 'metrics': {}}
        for annotator in ('A1', 'A2'):
            reference = load_reference_notes(ROOT / f'data/benchmarks/vocadito/Annotations/Notes/vocadito_{identifier}_notes{annotator}.csv')
            for name, events in versions.items():
                estimate = np.asarray([[e['source_start_seconds'], e['source_end_seconds'], 440 * 2 ** ((e['midi_pitch'] - 69) / 12)] for e in events if e['midi_pitch'] is not None], dtype=float).reshape(-1, 3)
                for with_offset, mode in ((False, 'onsetPitch'), (True, 'onsetOffsetPitch')):
                    metrics = note_metrics(reference, estimate, require_offset=with_offset)
                    matching = mir_eval.transcription.match_notes(reference[:, :2], reference[:, 2], estimate[:, :2], estimate[:, 2], offset_ratio=.2 if with_offset else None)
                    assert len(matching) == metrics['matchedNotes']
                    crosschecks += 1
                    row['metrics'][f'{annotator}.{name}.{mode}'] = {k: v for k, v in metrics.items() if k != 'matchedPairs'}
                    key = f'{annotator}.{name}.{mode}'
                    totals = counts.setdefault(key, {'matchedNotes': 0, 'referenceNotes': 0, 'estimatedNotes': 0})
                    for field in totals:
                        totals[field] += metrics[field]
        rows.append(row)
    for key, values in counts.items():
        values['microF1'] = 2 * values['matchedNotes'] / (values['referenceNotes'] + values['estimatedNotes'])
        values['macroF1'] = float(np.mean([row['metrics'][key]['f1'] for row in rows]))
    regressions = {}
    for annotator in ('A1', 'A2'):
        before, after = f'{annotator}.native.onsetOffsetPitch', f'{annotator}.aligned.onsetOffsetPitch'
        regressions[annotator] = {row['id']: row['metrics'][after]['f1'] - row['metrics'][before]['f1'] for row in rows if row['metrics'][after]['f1'] < row['metrics'][before]['f1'] - 1e-10}
    report = {'split': args.split, 'records': len(ids), 'sourceSha256': hashlib.sha256((ROOT / 'server/vocal_alignment.py').read_bytes()).hexdigest(),
              'scope': 'Development regression; unchanged learned note count/pitch, no global delay or reference timing passed to aligner. Not mixed-song accuracy.',
              'aggregates': counts, 'fullNoteF1Regressions': regressions, 'rows': rows, 'independentMatchingChecks': crosschecks, 'allMatchingCountsEqual': True}
    (ROOT / f'evidence/phase7/alignment-{args.split}.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'records': len(ids), 'aggregates': counts, 'regressions': regressions}, indent=2))


if __name__ == '__main__':
    main()

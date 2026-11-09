"""Evaluate an already-frozen pilot. Never writes inference inputs or notes."""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import pretty_midi
from scipy.optimize import linear_sum_assignment

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'evidence/lyrics-phrasing-20261108'
PREVIOUS = ROOT / 'evidence/lyrics-readable-20261108'


def pairs(ref, est, tolerance, exact=True):
    if not ref or not est:
        return []
    delta = abs(np.subtract.outer([n[0] for n in ref], [n[0] for n in est]))
    eligible = delta <= tolerance
    if exact:
        eligible &= np.equal.outer([n[2] for n in ref], [n[2] for n in est])
    dummy = 1 + min(len(ref), len(est)) * tolerance
    cost = np.concatenate([np.where(eligible, delta, 2 * dummy), np.full((len(ref), len(ref)), dummy)], axis=1)
    return [(int(i), int(j)) for i, j in zip(*linear_sum_assignment(cost)) if j < len(est)]


def main(reference):
    manifest = json.loads((OUT / 'review.json').read_text())
    audit = json.loads((OUT / 'audit.json').read_text())
    alignment = json.loads((ROOT / 'evidence/lyrics-assisted-20261108/sofa/alignment.json').read_text())
    alignment['segments'] += json.loads((OUT/'sofa/alignment.json').read_text())['segments']
    offset = json.loads((ROOT / 'evidence/konger/baseline-coverage-alignment.json').read_text())['offsetSeconds']
    human = pretty_midi.PrettyMIDI(str(reference))
    refs = sorted((n.start + offset, n.end + offset, n.pitch) for n in human.instruments[0].notes)
    spb, origin = 60 / manifest['grid']['bpm'], manifest['grid']['offsetSeconds']
    projects = {k: v['project'] for k, v in manifest['variants'].items()}
    projects['withoutLyrics'] = json.loads((OUT / 'without-lyrics-project.json').read_text())
    projects['previousLyrics'] = json.loads((PREVIOUS / 'review.json').read_text())['variants']['lyrics']['project']
    groups = [(13, 24), (25, 36), (45, 54)] + [(w['firstBar'], w['lastBar']) for w in manifest['windows']]
    result = []
    for first, last in groups:
        lo, hi = origin + first * 4 * spb, origin + (last + 1) * 4 * spb
        # The human MIDI's constant 65 BPM and the audio grid differ slightly.
        # Its original bar numbers determine membership, not candidate timing.
        ref = [n for n in refs if (first - 1) * 4 * 60 / 65 - 1e-5 <= n[0] - offset < last * 4 * 60 / 65 - 1e-5]
        variants = {}
        for key, project in projects.items():
            est = [(origin + n['start'] * spb, origin + (n['start'] + n['duration']) * spb, n['midi'])
                   for n in project['parts'][0]['notes'] if lo <= origin + n['start'] * spb < hi]
            matched = pairs(ref, est, .25)
            timing = pairs(ref, est, .25, exact=False)
            variants[key] = {
                'referenceNotes': len(ref), 'estimatedNotes': len(est),
                'matched120ms': len(pairs(ref, est, .12)), 'matched250ms': len(matched),
                'durationMAESeconds': round(float(np.mean([abs((ref[i][1]-ref[i][0])-(est[j][1]-est[j][0])) for i,j in matched])), 4),
                'shorterThan115ms': sum(b-a < .115 for a,b,_ in est),
                'octaveCandidates': [{'reference': ref[i], 'estimate': est[j]} for i,j in timing if abs(ref[i][2]-est[j][2]) == 12],
                'unmatchedReference': [n for i,n in enumerate(ref) if i not in {i for i,_ in matched}],
                'unmatchedEstimate': [n for j,n in enumerate(est) if j not in {j for _,j in matched}],
            }
        result.append({'firstBar': first, 'lastBar': last, 'variants': variants})
    words = {w['id']: w for segment in alignment['segments'] for w in segment['words']}
    changes = []
    for group in audit['ranges']:
        for decision in group['interpretation']['decisions']:
            if decision['action'] != 'split-same-pitch-at-syllable':
                continue
            at = decision['at']
            target = min(refs, key=lambda n: abs(n[0] - at))
            changes.append({'word': words[decision['wordId']]['text'], 'atSeconds': at,
                            'nearestReference': target, 'deltaSeconds': target[0] - at})
    report = {'experimentId': manifest['id'], 'referenceSha256': hashlib.sha256(reference.read_bytes()).hexdigest(),
              'referenceOffsetSeconds': offset, 'offsetRefitted': False,
              'referenceUsedForInference': False, 'ranges': result, 'addedAttacks': changes,
              'acceptance': 'candidate-awaiting-human-listening; metrics are supporting evidence only'}
    (OUT / 'evaluation.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({'experimentId': manifest['id'], 'addedAttacks': len(changes), 'ranges': [
        {'bars': [r['firstBar'], r['lastBar']], 'matches250ms': {k:v['matched250ms'] for k,v in r['variants'].items()}}
        for r in result]}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', type=Path, required=True)
    main(parser.parse_args().reference)

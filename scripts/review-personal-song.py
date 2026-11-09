#!/usr/bin/env python3
"""Private, section-by-section onset coverage against a human MIDI export.

The part map comes from the author's score, never from its playback programs.
References are evaluation-only. Audio alignment uses transients, not predicted
notes, and never adjusts individual note times to improve a score.
"""
from __future__ import annotations
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import subprocess

import numpy as np
import pretty_midi
import mir_eval


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def align_audio(audio, references, duration):
    import librosa
    from scipy.ndimage import gaussian_filter1d
    from scipy.signal import correlate
    decoded = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-i', str(audio),
                              '-f', 'f32le', '-ac', '1', '-ar', '16000', '-'],
                             capture_output=True, check=True)
    y = np.frombuffer(decoded.stdout, dtype='<f4')
    strength = librosa.onset.onset_strength(y=y, sr=16000, hop_length=160, n_fft=1024)
    # One vote per chord onset, regardless of the number of chord tones.
    template = np.zeros(round(duration * 100) + 1)
    for at in sorted(set(round(n['start'] * 100) for n in references)):
        template[at] = 1
    template = gaussian_filter1d(template, 1)
    strength = np.minimum(strength, np.quantile(strength, .97))
    correlation = correlate(strength, template, mode='full', method='fft')
    lo = len(template) - 1
    candidates = correlation[lo:lo + 1501]
    index = int(np.argmax(candidates))
    best = index / 100
    # Retain widely separated competing phases for manual inspection.
    peaks = []
    for i in np.argsort(candidates)[::-1]:
        if all(abs(i / 100 - p['offsetSeconds']) > .3 for p in peaks):
            peaks.append({'offsetSeconds': int(i) / 100, 'strength': float(candidates[i])})
        if len(peaks) == 5:
            break
    return {'offsetSeconds': best, 'method': 'Global 10ms audio transient / human onset-template correlation',
            'allowedOffsetRangeSeconds': [0, 15], 'perNoteWarp': False,
            'usesPredictedNotes': False, 'competingOffsets': peaks}


def match(refs, preds, tolerance):
    if not refs or not preds:
        return []
    intervals = lambda notes: np.asarray([[n['start'], max(n['start'] + .01, n['end'])] for n in notes])
    pitches = lambda notes: 440 * 2 ** ((np.asarray([n['midi'] for n in notes]) - 69) / 12)
    return mir_eval.transcription.match_notes(intervals(refs), pitches(refs), intervals(preds), pitches(preds),
                                               onset_tolerance=tolerance, offset_ratio=None)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--audio', type=Path, required=True)
    parser.add_argument('--midi', type=Path, required=True)
    parser.add_argument('--part-map', type=Path, required=True)
    parser.add_argument('--events', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--alignment', type=Path)
    args = parser.parse_args()
    midi = pretty_midi.PrettyMIDI(str(args.midi))
    mapping = json.loads(args.part_map.read_text())
    refs = []
    for index, instrument in enumerate(midi.instruments):
        role = mapping['tracks'][str(index)]
        refs.extend({'start': n.start, 'end': n.end, 'midi': n.pitch, 'role': role, 'track': index}
                    for n in instrument.notes)
    alignment = json.loads(args.alignment.read_text()) if args.alignment else align_audio(args.audio, refs, midi.get_end_time())
    offset = alignment['offsetSeconds']
    for ref in refs:
        ref['start'] += offset
        ref['end'] += offset
    payload = json.loads(args.events.read_text())
    preds = [n for n in payload['events'] if not n['isDrum']]
    tempos = midi.get_tempo_changes()
    if len(tempos[0]) != 1:
        raise ValueError('Review sections currently require a constant-tempo reference')
    bar = 240 / tempos[1][0]
    rows = []
    for role, programs in mapping['acceptedPrograms'].items():
        r = [n for n in refs if n['role'] == role]
        same = [n for n in preds if n['program'] in programs]
        all_matches = {i: j for i, j in match(r, preds, .12)}
        correct = {i: j for i, j in match(r, same, .12)}
        strict = {i for i, _ in match(r, same, .05)}
        sections = []
        for section in range(int(np.ceil(midi.get_end_time() / (4 * bar)))):
            begin, end = offset + section * 4 * bar, offset + (section + 1) * 4 * bar
            indices = [i for i, n in enumerate(r) if begin <= n['start'] < end]
            sections.append({'firstBar': section * 4 + 1, 'lastBar': section * 4 + 4,
                'audioStartSeconds': round(begin, 3), 'audioEndSeconds': round(end, 3),
                'referenceNotes': len(indices), 'correctClassMatches120ms': sum(i in correct for i in indices),
                'anyClassMatches120ms': sum(i in all_matches for i in indices),
                'unmatchedReference': [r[i] for i in indices if i not in all_matches]})
        rows.append({'role': role, 'referenceNotes': len(r), 'predictedNotesInClasses': len(same),
                     'acceptedPrograms': programs, 'correctClassMatches50ms': len(strict),
                     'correctClassMatches120ms': len(correct), 'anyClassMatches120ms': len(all_matches),
                     'matchedPrograms': dict(Counter(preds[j]['program'] for j in all_matches.values())),
                     'sections': sections})
    report = {'scope': 'Author supplied development transcription, not complete acoustic ground truth or unseen validation',
              'alignment': alignment, 'referencePartMap': mapping,
              'sources': {name: {'path': str(p.resolve()), 'sha256': sha(p)} for name, p in
                          [('audio', args.audio), ('midi', args.midi), ('events', args.events), ('partMap', args.part_map)]},
              'limitations': ['MIDI program is playback timbre, part identity comes from the human score.',
                  'Onset-only coverage at 50ms and 120ms; human quantization, slurs and ornaments can differ.',
                  'Any-class coverage is an upper bound, not proof of an instrument reassignment.',
                  'Unannotated instrumental layers are not automatically false positives.'], 'parts': rows}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    args.output.with_name(args.output.stem + '-alignment.json').write_text(json.dumps(alignment, indent=2))
    for row in rows:
        print(row['role'], 'reference', row['referenceNotes'], 'correct class', row['correctClassMatches120ms'],
              'any class', row['anyClassMatches120ms'])
    print('alignment', alignment['offsetSeconds'])


if __name__ == '__main__':
    main()

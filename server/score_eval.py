"""Evaluation-only comparison of Coro projects with a human reference score.

Never imported by the analysis pipeline. The reference is an acceptance
instrument: nothing here feeds inference, tuning targets, or project notes.

All comparisons happen in score beats on the project's own grid. The reference
is mapped with a single linear beat transform (tempo ratio plus offset). No
note in either score is moved individually, so section numbers are comparable
across runs that share a grid. Runs on different grids are aligned separately
and therefore reported with their own transform.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from scipy.optimize import linear_sum_assignment

DOTTED_SIXTEENTHS = (3, 6, 12, 24)


@dataclass
class ReferenceMap:
    """How reference beats map to project beats: project = ratio * ref + offset."""
    ratio: float = 1.0
    offset: float = 0.0
    beats_per_bar: int = 4
    first_bar_beat: float = 0.0  # project beat at reference bar 1
    notes: dict = field(default_factory=dict)

    def bar_range(self, first: int, last: int) -> tuple[float, float]:
        return (self.first_bar_beat + (first - 1) * self.beats_per_bar,
                self.first_bar_beat + last * self.beats_per_bar)


def load_reference_midi(path: Path, tracks: dict[str, list[int]], *, first_bar_beat: float = 0.0) -> ReferenceMap:
    """Read a constant-tempo reference MIDI as beats grouped by role.

    ``first_bar_beat`` is the project beat of reference bar 1. It is a single
    explicit alignment constant and is recorded in every report.
    """
    import pretty_midi
    midi = pretty_midi.PrettyMIDI(str(path))
    times, tempos = midi.get_tempo_changes()
    if len(set(np.round(tempos, 3))) != 1:
        raise ValueError('Reference with tempo changes needs a beat map; not supported yet')
    ref_bpm = float(tempos[0])
    beat = 60 / ref_bpm
    notes = {}
    for role, indices in tracks.items():
        rows = []
        for index in indices:
            for note in midi.instruments[index].notes:
                rows.append({'start': note.start / beat + first_bar_beat, 'duration': (note.end - note.start) / beat,
                             'midi': int(note.pitch), 'track': index})
        notes[role] = sorted(rows, key=lambda n: (n['start'], n['midi']))
    signature = midi.time_signature_changes[0].numerator if midi.time_signature_changes else 4
    return ReferenceMap(ratio=1.0, offset=first_bar_beat, beats_per_bar=signature,
                        first_bar_beat=first_bar_beat, notes=notes)


def _match(ref: list[dict], est: list[dict], tolerance: float, same_pitch=True) -> list[tuple[int, int]]:
    if not ref or not est:
        return []
    cost = np.full((len(ref), len(est)), 99.0)
    for i, r in enumerate(ref):
        for j, e in enumerate(est):
            distance = abs(r['start'] - e['start'])
            if distance > tolerance + 1e-6:
                continue
            if same_pitch and r['midi'] != e['midi']:
                continue
            if not same_pitch and (r['midi'] == e['midi'] or (r['midi'] - e['midi']) % 12):
                continue
            cost[i, j] = distance
    rows, cols = linear_sum_assignment(cost)
    return [(i, j) for i, j in zip(rows, cols) if cost[i, j] < 99]


def _reattacks(notes: list[dict]) -> list[int]:
    """Indices of notes that repeat the previous pitch (same-pitch re-attacks)."""
    ordered = sorted(range(len(notes)), key=lambda i: notes[i]['start'])
    return [b for a, b in zip(ordered, ordered[1:])
            if notes[a]['midi'] == notes[b]['midi'] and notes[b]['start'] - notes[a]['start'] <= 2.0]


def section_metrics(ref: list[dict], est: list[dict], lo: float, hi: float, *, monophonic: bool) -> dict:
    """Score-level metrics in beats. Exact means same pitch and the same
    sixteenth grid point; near means within a sixteenth."""
    R = [n for n in ref if lo <= n['start'] < hi]
    E = [n for n in est if n.get('midi') is not None and lo <= n['start'] < hi]
    exact = _match(R, E, 0.01)
    near = _match(R, E, 0.26)
    octave = _match(R, E, 0.01, same_pitch=False)
    precision = len(exact) / max(1, len(E))
    recall = len(exact) / max(1, len(R))
    result = {
        'ref': len(R), 'est': len(E), 'exact': len(exact), 'near16': len(near), 'octaveOnly': len(octave),
        'F': round(2 * precision * recall / max(1e-9, precision + recall), 3),
        'durationAgree': sum(abs(R[i]['duration'] - E[j]['duration']) <= 0.13 for i, j in exact),
        'dotted': sum(round(n['duration'] * 16) in DOTTED_SIXTEENTHS for n in E),
        'refDotted': sum(round(n['duration'] * 16) in DOTTED_SIXTEENTHS for n in R),
        'subSixteenth': sum(n['duration'] < 0.25 - 1e-6 for n in E),
    }
    if monophonic:
        matched_ref = {i for i, _ in exact}
        reattacks = _reattacks(R)
        result['refReattacks'] = len(reattacks)
        result['reattacksFound'] = sum(i in matched_ref for i in reattacks)
    else:
        # Sustained low register: reference notes below middle C lasting >= 2 beats.
        long_low = [i for i, n in enumerate(R) if n['midi'] < 60 and n['duration'] >= 2 - 1e-6]
        by_ref = dict(exact)
        result['refSustainedBass'] = len(long_low)
        result['sustainedBassCovered'] = sum(i in by_ref and E[by_ref[i]]['duration'] >= 0.75 * R[i]['duration']
                                             for i in long_low)
        result['estSubBeatLow'] = sum(n['midi'] < 60 and n['duration'] < 1 - 1e-6 for n in E)
        result['arpeggioMarks'] = sum(bool(n.get('arpeggio')) for n in E)
    return result


def project_part_notes(project: dict, selector) -> list[dict]:
    notes = []
    for part in project['parts']:
        if selector(part):
            notes.extend({'start': float(n['start']), 'duration': float(n['duration']), 'midi': n.get('midi'),
                          'arpeggio': n.get('arpeggio', False)} for n in part['notes'] if n.get('midi') is not None)
    return sorted(notes, key=lambda n: (n['start'], n['midi']))


ROLE_SELECTORS = {
    'lead': lambda part: part.get('role') == 'lead',
    'piano': lambda part: str(part.get('id', '')).startswith('piano'),
    'strings': lambda part: str(part.get('id', '')).startswith('strings'),
}


def evaluate(projects: dict[str, dict], reference: ReferenceMap, sections: list[tuple[int, int]]) -> dict:
    report = {'alignment': {'firstBarBeat': reference.first_bar_beat, 'beatsPerBar': reference.beats_per_bar,
                            'method': 'single linear beat transform; no per-note warping'},
              'sections': [f'{a}-{b}' for a, b in sections], 'candidates': {}}
    for name, project in projects.items():
        row = {}
        for role, ref in reference.notes.items():
            est = project_part_notes(project, ROLE_SELECTORS[role])
            row[role] = {f'{a}-{b}': section_metrics(ref, est, *reference.bar_range(a, b), monophonic=role == 'lead')
                         for a, b in sections}
        report['candidates'][name] = row
    return report


def format_table(report: dict, role: str, keys=('exact', 'ref', 'F', 'dotted')) -> str:
    lines = [f'{"candidate":34s} ' + ' | '.join(f'{s:>18s}' for s in report['sections'])]
    for name, row in report['candidates'].items():
        if role not in row:
            continue
        cells = []
        for section in report['sections']:
            m = row[role][section]
            cells.append(f"{m['exact']:3d}/{m['ref']:<3d} F{m['F']:.2f} d{m['dotted']:<3d}")
        lines.append(f'{name[:34]:34s} ' + ' | '.join(f'{c:>18s}' for c in cells))
    return '\n'.join(lines)


def main(argv=None) -> int:
    import argparse
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--reference', type=Path, required=True, help='private reference MIDI (evaluation only)')
    parser.add_argument('--tracks', required=True, help='role=idx[,idx];... e.g. lead=0;piano=1,2;strings=3')
    parser.add_argument('--first-bar-beat', type=float, default=4.0, help='project beat of reference bar 1')
    parser.add_argument('--candidate', action='append', default=[], metavar='NAME=PROJECT.json', required=True)
    parser.add_argument('--sections', default='13-24,21-35,45-54,1-70')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args(argv)
    tracks = {role: [int(x) for x in idx.split(',')] for role, idx in (p.split('=') for p in args.tracks.split(';'))}
    reference = load_reference_midi(args.reference, tracks, first_bar_beat=args.first_bar_beat)
    projects = {}
    for item in args.candidate:
        name, path = item.split('=', 1)
        data = json.loads(Path(path).read_text())
        projects[name] = data.get('project', data)
    sections = [tuple(int(x) for x in s.split('-')) for s in args.sections.split(',')]
    report = evaluate(projects, reference, sections)
    report['reference'] = str(args.reference)
    report['limitations'] = ['Development reference, not a blind test.',
                             'Exact = same pitch on the same sixteenth; human scores may notate expressively.',
                             'Single global alignment; tempo drift in the recording is not modelled.']
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=1) + '\n')
    for role in tracks:
        print(f'\n[{role}] exact/ref, F, written dotted notes')
        print(format_table(report, role))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

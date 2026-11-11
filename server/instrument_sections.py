"""Whole-song instrument sections for the readable score (attribution layer).

YourMT3+ decodes every string class through one shared channel. Within a song
it often splits one bowed texture across violin/viola/cello/ensemble labels at
the same instants, and spends a few notes on a neighbouring class (harp,
synth). This pass decides once per song how bowed strings are written, then
folds low-evidence isolated classes into the part the decoder itself
associates them with. No note is deleted; reference scores are never an input.
Native and source-refined event files are not modified.
"""
from __future__ import annotations

from collections import Counter
import statistics

VERSION = 'instrument-sections-1'
BOWED_SOLO = (40, 41, 42, 43)
BOWED_ENSEMBLE = (44, 45, 48, 49)
BOWED = BOWED_SOLO + BOWED_ENSEMBLE
VOCAL = (100, 101)
SOLO_RATIO = .5
LOW_EVIDENCE_MIN = 12
LOW_EVIDENCE_SHARE = .01
COVER_SHARE = .75
FOLD_ONSET = .06
SECTIONS = {40: (40,), 41: (41,), 42: (42, 43)}


def decoder_channel(program: int, drum: bool = False) -> int:
    """YourMT3+ mc13 (gm_plus) program-to-channel table, used when an event lacks it."""
    if drum:
        return 12
    if program in VOCAL:
        return 11
    edges = [(8, 0), (16, 1), (24, 2), (32, 3), (40, 4), (56, 5), (64, 6), (72, 7), (80, 8), (88, 9), (96, 10)]
    return next((channel for edge, channel in edges if program < edge), -1)


def _quantile(values: list[int], q: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, round(q * (len(ordered) - 1))))]


def _overlap(a: dict, b: dict) -> float:
    return min(a['end'], b['end']) - max(a['start'], b['start'])


def string_writing(pool: list[dict]) -> tuple[dict[int, int], dict]:
    """Choose one written form for the whole song: one ensemble, or <=3 sections.

    Returns a target program per pool event (by list index) and the audit.
    """
    if not pool:
        return {}, {'mode': 'none', 'bowedNotes': 0}
    counts = Counter(e['program'] for e in pool)
    solo = sum(counts[p] for p in BOWED_SOLO)
    pitches = {s: [e['midi'] for e in pool if e['program'] in members] for s, members in SECTIONS.items()}
    medians = {s: statistics.median(v) for s, v in pitches.items() if v}
    ordered = [medians[s] for s in (40, 41, 42) if s in medians]
    is_ordered = all(a > b for a, b in zip(ordered, ordered[1:]))
    audit = {'mode': 'ensemble', 'bowedNotes': len(pool), 'soloNotes': solo,
             'soloShare': round(solo / len(pool), 4), 'programCounts': dict(sorted(counts.items())),
             'sectionMedians': medians, 'registerOrdered': is_ordered,
             'rule': f'sections iff solo share >= {SOLO_RATIO} and violin > viola > cello median pitch'}
    targets = {}
    if solo >= SOLO_RATIO * len(pool) and is_ordered and medians:
        audit['mode'] = 'sections'
        ranges = {s: (_quantile(pitches[s], .1), _quantile(pitches[s], .9)) for s in medians}
        audit['sectionRanges'] = ranges
        assigned = Counter()
        for index, e in enumerate(pool):
            if e['program'] in BOWED_SOLO:
                targets[index] = 42 if e['program'] == 43 else e['program']
                continue
            inside = [s for s, (lo, hi) in ranges.items() if lo <= e['midi'] <= hi]
            targets[index] = inside[0] if len(inside) == 1 else min(
                medians, key=lambda s: (abs(medians[s] - e['midi']), s))
            assigned[targets[index]] += 1
        audit['ensembleAssignments'] = dict(sorted(assigned.items()))
    else:
        targets = {index: 48 for index in range(len(pool))}
    return targets, audit


def consolidate_instruments(events: list[dict]) -> tuple[list[dict], dict]:
    work = [dict(e) for e in events]
    pool_indices = [i for i, e in enumerate(work)
                    if not e['isDrum'] and not e.get('sourceId') and e['program'] in BOWED]
    targets, strings = string_writing([work[i] for i in pool_indices])
    relabelled = 0
    for local, index in enumerate(pool_indices):
        e = work[index]
        if targets[local] != e['program']:
            e['decodedProgram'] = e['program']
            e['program'] = targets[local]
            relabelled += 1
    strings['relabelledNotes'] = relabelled
    bowed = {(work[i]['program'], '') for i in pool_indices}

    pitched = [e for e in work if not e['isDrum'] and e['program'] not in VOCAL]
    threshold = max(LOW_EVIDENCE_MIN, LOW_EVIDENCE_SHARE * len(pitched))
    groups: dict[tuple[int, str], list[dict]] = {}
    for e in pitched:
        groups.setdefault((e['program'], e.get('sourceId') or ''), []).append(e)
    channels = {key: Counter(e.get('decodedChannel', decoder_channel(e.get('decodedProgram', key[0])))
                             for e in rows).most_common(1)[0][0] for key, rows in groups.items()}
    hosts = [key for key, rows in groups.items() if len(rows) >= threshold]
    decisions, absorbed = [], 0
    for key, rows in sorted(groups.items()):
        if len(rows) >= threshold or key in bowed:
            continue
        options = []
        for host in hosts:
            covered = sum(any(abs(h['midi'] - n['midi']) in (0, 12) and _overlap(h, n) >= .5 * (n['end'] - n['start'])
                              for h in groups[host]) for n in rows)
            coverage = covered >= COVER_SHARE * len(rows)
            same_channel = channels[host] == channels[key]
            if same_channel or coverage:
                options.append(((coverage, covered, same_channel), host))
        record = {'program': key[0], 'sourceId': key[1] or None, 'notes': len(rows),
                  'decodedChannel': channels[key], 'threshold': round(threshold, 2)}
        if not options:
            decisions.append({**record, 'action': 'pending'})
            continue
        (coverage, covered, same_channel), host = max(options, key=lambda item: (item[0], -item[1][0]))
        host_rows, merged = groups[host], 0
        label = next((h.get('sourceLabel') for h in host_rows if h.get('sourceLabel')), None)
        for n in rows:
            twin = next((h for h in host_rows if h['midi'] == n['midi'] and abs(h['start'] - n['start']) <= FOLD_ONSET
                         and _overlap(h, n) > 0), None)
            if twin is not None:
                twin['start'], twin['end'] = min(twin['start'], n['start']), max(twin['end'], n['end'])
                twin.setdefault('foldedFrom', []).append(key[0])
                n['_absorbed'] = True
                merged += 1
                continue
            n.setdefault('decodedProgram', n['program'])
            n['program'], n['foldedFrom'] = host[0], key[0]
            if host[1]:
                n['sourceId'] = host[1]
                if label:
                    n['sourceLabel'] = label
        absorbed += merged
        decisions.append({**record, 'action': 'fold', 'hostProgram': host[0], 'hostSourceId': host[1] or None,
                          'reason': 'same_decoder_channel' if same_channel else 'unison_or_octave_coverage',
                          'coveredNotes': covered, 'mergedIntoHostNotes': merged})
    # Unresolved low-evidence classes stay exactly as decoded (audit only).
    result = [e for e in work if not e.pop('_absorbed', False)]
    return sorted(result, key=lambda n: (n['start'], n['program'], n['midi'])), {
        'version': VERSION, 'strings': strings, 'isolatedClasses': decisions,
        'lowEvidenceThreshold': round(threshold, 2), 'absorbedNotes': absorbed,
        'inputEvents': len(events), 'outputEvents': len(result),
        'claimsIndividualPerformerIdentity': False, 'referenceUsed': False}


def written_program(program: int, audit: dict | None) -> int | None:
    """The part program a decoded bowed class is written in; None if per-note."""
    mode = ((audit or {}).get('strings') or {}).get('mode')
    if program not in BOWED or mode in (None, 'none'):
        return program
    if mode == 'ensemble':
        return 48
    return 42 if program == 43 else program if program in BOWED_SOLO else None

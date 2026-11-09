"""Experimental notation grammar over frozen, monophonic acoustic events.

This opt-in experiment retains every attack and pitch. Acoustic durations live
in the audit; the decoder scores written note values and intervening rests as
well as timing. It does not claim to infer syllables from durations alone.
"""
from __future__ import annotations

import math
from functools import lru_cache

import numpy as np

VERSION = "vocal-notation-grammar-ab-3"
TICKS = 32  # One quarter note. Fine values remain available for genuine attacks.


@lru_cache(maxsize=4096)
def value_cost(ticks: int) -> float:
    """A conventional/dotted value costs less than several tied fragments."""
    if ticks <= 0:
        return 0.
    values = (128, 96, 64, 48, 32, 24, 16, 12, 8, 6, 4, 3, 2, 1)
    if ticks > 128:
        return .4 + value_cost(ticks - 128)
    costs = [0.] + [math.inf] * ticks
    for n in range(1, ticks + 1):
        for value in values:
            if value <= n:
                fine = .0 if value >= 8 else .3 if value >= 4 else 1.6
                costs[n] = min(costs[n], costs[n - value] + .65 + fine)
    return costs[ticks]


def infer_vocal_notation(events: list[dict], grid: dict, duration: float) -> tuple[list[dict], dict]:
    bpm, origin = float(grid['bpm']), float(grid['offsetSeconds'])
    if not all(map(math.isfinite, (bpm, origin, duration))) or not 20 <= bpm <= 300 or duration <= 0:
        raise ValueError('Invalid vocal notation clock')
    spb = 60 / bpm
    rows = [(float(e['start']), float(e['end']), e['midi']) for e in events]
    if any(not all(map(math.isfinite, row)) or row[0] < max(0, origin) - 1e-6
           or row[1] <= row[0] or row[1] > duration + 1e-6
           or not 0 <= row[2] <= 127 or row[2] != int(row[2]) for row in rows):
        raise ValueError('Invalid vocal event')
    if any(a[1] > b[0] + 1e-6 for a, b in zip(rows, rows[1:])):
        raise ValueError('Ordered monophonic events required')
    if not rows:
        return [], {'version': VERSION, 'changes': [], 'inputEvents': 0, 'outputNotes': 0}

    onset_limit = min(.16, .24 * spb)
    release_limit = min(.20, .30 * spb)

    def points(at, limit):
        position = (at - origin) / spb * TICKS
        left = max(0, math.ceil(position - limit / spb * TICKS - 1e-7))
        right = math.floor(position + limit / spb * TICKS + 1e-7)
        return range(left, right + 1)

    def metric_cost(tick):
        # Retain the baseline's metrical prior; this experiment adds written
        # value/rest grammar rather than weakening the existing fine-grid cost.
        for divisor, cost in ((32, 0.), (16, .08), (8, .24), (4, 1.05), (2, 3.), (1, 5.)):
            if tick % divisor == 0:
                return cost
        return 0.

    choices = []
    for index, (start, end, _) in enumerate(rows):
        intervals = ([start - rows[index - 1][0]] if index else []) + (
            [rows[index + 1][0] - start] if index + 1 < len(rows) else [])
        # Distinct rapid attacks have tighter bounds, rather than being deleted
        # to satisfy a minimum printed duration.
        spacing = min(intervals, default=math.inf)
        local_limit = min(onset_limit, .45 * spacing) if spacing <= .1875 * spb else onset_limit
        options = []
        for left in points(start, local_limit):
            onset_error = (origin + left / TICKS * spb - start) / max(.025, local_limit)
            for right in points(end, release_limit):
                if right <= left:
                    continue
                release_error = (origin + right / TICKS * spb - end) / release_limit
                cost = (.85 * onset_error ** 2 + .65 * release_error ** 2
                        + metric_cost(left) + .75 * metric_cost(right)
                        + value_cost(right - left) + (.0 if right - left >= 4 else 5.))
                options.append((left, right, cost))
        if not options:
            raise ValueError('No bounded notation candidate; retain acoustic baseline')
        choices.append(np.asarray(options))

    costs = choices[0][:, 2]
    pointers = []
    for index in range(1, len(rows)):
        previous, current = choices[index - 1], choices[index]
        gaps = current[:, 0, None] - previous[None, :, 1]
        gap_seconds = gaps / TICKS * spb
        raw_gap = rows[index][0] - rows[index - 1][1]
        allowed = gaps >= 0
        # A real rest keeps at least its bounded duration; a shared model
        # boundary stays shared. Intermediate gaps may be articulation releases.
        if raw_gap >= .18:
            allowed &= gap_seconds >= max(.125 * spb, raw_gap - .12) - 1e-7
        elif raw_gap <= 1e-6:
            allowed &= gaps == 0
        rest_cost = np.zeros(gaps.shape)
        for gap in np.unique(gaps[gaps > 0]):
            rest_cost[gaps == gap] = value_cost(int(gap)) + (1.0 if raw_gap < .18 else 0.)
        totals = np.where(allowed, costs[None, :] + rest_cost, np.inf)
        back = np.argmin(totals, axis=1)
        costs = totals[np.arange(len(current)), back] + current[:, 2]
        pointers.append(back)
    index = int(np.argmin(costs))
    if not math.isfinite(costs[index]):
        raise ValueError('No collision-free bounded notation path; retain baseline')
    selected = [None] * len(rows)
    for row_index in range(len(rows) - 1, -1, -1):
        selected[row_index] = choices[row_index][index]
        if row_index:
            index = int(pointers[row_index - 1][index])
    notes, changes = [], []
    for index, ((start, end, pitch), (left, right, _)) in enumerate(zip(rows, selected)):
        left, right = int(left), int(right)
        source_id = str(events[index].get('id', f'game-{index}'))
        notes.append({'id': source_id, 'midi': int(pitch), 'start': left / TICKS,
                      'duration': (right - left) / TICKS, 'velocity': .7, 'origin': 'transcribed'})
        changes.append({'eventId': source_id, 'eventIndex': index,
                        'sourceStartSeconds': start, 'sourceEndSeconds': end,
                        'scoreStartSeconds': origin + left / TICKS * spb,
                        'scoreEndSeconds': origin + right / TICKS * spb})
    return notes, {'version': VERSION, 'inputEvents': len(rows), 'outputNotes': len(notes),
                   'pitchSequenceUnchanged': True, 'referenceUsed': False,
                   'onsetLimitSeconds': onset_limit, 'releaseLimitSeconds': release_limit,
                   'changes': changes, 'decision': 'candidate-pending-review',
                   'limitations': ['No syllable inference, pitch correction or missing-note recovery',
                                   'Binary/dotted meter grammar; explicit triplets need a separate candidate',
                                   'Written duration differs from acoustic gate; both are retained']}

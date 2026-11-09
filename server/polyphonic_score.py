"""Bounded notation of measured polyphonic events; no pitch or attack deletion."""
from __future__ import annotations

import math

VERSION = 'polyphonic-bounded25ms-2'
TICKS = 960


def quantize_polyphonic_events(events: list, grid: dict, duration: float, part_id: str,
                               *, percussion: bool = False) -> tuple[list[dict], dict]:
    bpm, offset = float(grid['bpm']), float(grid['offsetSeconds'])
    if not all(math.isfinite(v) for v in (bpm, offset, duration)) or not 20 <= bpm <= 300 or duration <= 0:
        raise ValueError('Invalid polyphonic score grid')
    spb, bound = 60 / bpm, .025
    rows, outside, clipped = [], 0, 0
    for event in events:
        if len(event) < 4:
            raise ValueError('Polyphonic event needs onset, offset, pitch and velocity')
        start, end, pitch, strength = map(float, event[:4])
        if (not all(math.isfinite(v) for v in (start, end, pitch, strength)) or start < 0
                or end <= start or not 0 <= pitch <= 127 or pitch != int(pitch)):
            raise ValueError('Invalid polyphonic event')
        if start >= duration:
            outside += 1
            continue
        clipped += int(end > duration)
        rows.append((start, min(end, duration), int(pitch), max(.01, min(1., strength))))
    rows.sort(key=lambda row: (row[0], row[2], row[1]))

    def choose(seconds):
        beat = (seconds - offset) / spb
        options = []
        for step, cost in ((1., 0.), (.5, .1), (.25, .3), (.125, .6), (.0625, 1.), (.03125, 2.), (1 / TICKS, 8.)):
            point = round(beat / step) * step
            shift = abs(offset + point * spb - seconds)
            if point >= 0 and shift <= bound + 1e-9:
                options.append((cost + shift / bound, point))
        if not options:
            raise ValueError('Polyphonic event cannot fit the score timeline within 25ms')
        return min(options)[1]

    starts = [choose(row[0]) for row in rows]
    ends = [choose(row[1]) for row in rows]
    by_pitch = {}
    for index, row in enumerate(rows):
        groups = by_pitch.setdefault(row[2], [])
        if groups and abs(rows[groups[-1][0]][0] - row[0]) <= 1e-7:
            groups[-1].append(index)
        else:
            groups.append([index])
    fine_indices = set()
    for groups in by_pitch.values():
        fine = {g for g, indices in enumerate(groups)
                if not percussion and any(ends[i] <= starts[i] for i in indices)}
        while True:
            # Refine only a connected collision neighbourhood. A short note
            # in one bar must not de-quantize every equal pitch in the song.
            for g in sorted(fine):
                indices = groups[g]
                tick = max(0, round((rows[indices[0]][0] - offset) / spb * TICKS))
                if g - 1 in fine:
                    tick = max(tick, round(starts[groups[g - 1][0]] * TICKS) + 1)
                for i in indices:
                    starts[i] = tick / TICKS
                    ends[i] = max(tick + 1, round((rows[i][1] - offset) / spb * TICKS)) / TICKS
            collisions = {g for g in range(1, len(groups))
                          if starts[groups[g][0]] <= starts[groups[g - 1][0]] + 1e-7}
            needed = collisions | {g - 1 for g in collisions}
            if needed <= fine:
                break
            fine.update(needed)
        fine_indices.update(i for g in fine for i in groups[g])

    if percussion:
        # YourMT3 drum offsets are a decoder convention, not measured note
        # releases. Notate the hit rhythm, never a 10ms sustain plus tiny rests.
        attacks = sorted(set(starts))
        next_attack = dict(zip(attacks, attacks[1:]))
        for i, a in enumerate(starts):
            gap = min(1., next_attack.get(a, a + 1.) - a)
            value = next((v for v in (1., .5, .25, .125, .0625, .03125) if v <= gap + 1e-7), gap)
            ends[i] = a + max(1 / TICKS, value)
    notes, changes = [], []
    for index, ((start, end, pitch, strength), a) in enumerate(zip(rows, starts), 1):
        b = ends[index - 1]
        scored_start, scored_end = offset + a * spb, offset + b * spb
        if abs(scored_start - start) > bound + 1e-7 or (not percussion and abs(scored_end - end) > bound + 1e-7):
            raise ValueError('Polyphonic score exceeded its timing bound')
        note = {'id': f'{part_id}-q{index}', 'midi': pitch, 'start': round(a, 9),
                'duration': round(b - a, 9), 'velocity': strength, 'origin': 'transcribed'}
        if percussion:
            note['lyric'] = 'dum' if pitch in (35, 36) else 'ka' if pitch in (37, 38, 39, 40) else 'ts'
        notes.append(note)
        changes.append({'noteId': note['id'], 'sourceStartSeconds': start, 'sourceEndSeconds': end,
                        'scoreStartSeconds': scored_start, 'scoreEndSeconds': scored_end})
    return notes, {'version': VERSION, 'inputEvents': len(events), 'outputNotes': len(notes),
                   'outsideAnalysisEvents': outside, 'timingToleranceSeconds': bound,
                   'clippedOffsetEvents': clipped, 'timingBoundReference': 'analysis-clipped native events',
                   'fineGridEvents': len(fine_indices), 'fineGridScope': 'local collision neighbourhood',
                   'offsetPolicy': 'notated hit rhythm; decoder offsets are not acoustic releases' if percussion else 'bounded native offset',
                   'offsetTimingToleranceSeconds': None if percussion else bound,
                   'maximumOnsetShiftSeconds': max((abs(c['scoreStartSeconds'] - c['sourceStartSeconds']) for c in changes), default=0),
                   'maximumOffsetShiftSeconds': max((abs(c['scoreEndSeconds'] - c['sourceEndSeconds']) for c in changes), default=0),
                   'preservesPolyphony': True, 'noAttackDeduplication': True, 'boundaryChanges': changes}

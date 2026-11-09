"""Infer readable score rhythm from performance events, retaining an edit audit.

This is an editorial score, not a claim that acoustic releases equal written
durations. Native events remain the authoritative transcription evidence.
"""
from __future__ import annotations

from collections import defaultdict
from bisect import bisect_left
import math
import statistics

VERSION = 'multiscore-rhythm-4'
TICKS = 960


def infer_notation_grid(events: list[dict], grid: dict, *, tempo_locked: bool = False) -> dict:
    result = dict(grid)
    bpm = float(grid['bpm'])
    intervals = []
    by_program = defaultdict(set)
    for event in events:
        if not event['isDrum']:
            by_program[event['program']].add(event['start'])
    for times in by_program.values():
        times = sorted(times)
        intervals.extend(b - a for a, b in zip(times, times[1:]) if .035 <= b - a <= 2.)
    fast = sum(value * bpm / 60 < .125 for value in intervals)
    # A half-time pulse plus sustained fast subdivisions is evidence for a
    # different written beat unit. This never speeds up the source audio.
    factor = 2 if (not tempo_locked and 60 <= bpm < 90 and bpm * 2 <= 180
                   and fast >= max(12, len(intervals) * .12)) else 1
    result.update(bpm=round(bpm * factor, 4), notationUnitFactor=factor,
                  detectedBpm=bpm, notationProfile=VERSION)
    # Keep the inferred downbeat phase, but do not add an extra empty bar when
    # changing the beat unit. Audio-relative onsets are recomputed afterwards.
    period = 240 / result['bpm']
    phase = float(grid['offsetSeconds']) % period
    result['offsetSeconds'] = round(phase - period if phase > .025 else phase, 6)
    correction, support = _shared_onset_phase(events, result)
    result['beatTrackerOffsetSeconds'] = result['offsetSeconds']
    result['onsetPhaseCorrectionSeconds'] = correction
    result['onsetPhaseSupportPrograms'] = support
    result['offsetSeconds'] = round(result['offsetSeconds'] + correction, 6)
    return result


def _clusters(values: list[float], tolerance: float) -> list[float]:
    groups = []
    for value in sorted(values):
        if groups and value - groups[-1][0] <= tolerance:
            groups[-1].append(value)
        else:
            groups.append([value])
    return [statistics.median(group) for group in groups]


def _shared_onset_phase(events: list[dict], grid: dict) -> tuple[float, list[int]]:
    """Correct a shared beat-tracker delay, never a single player's phrasing.

    Give instrument classes equal votes so a dense arpeggio or a many-note
    chord cannot pull the entire song's phase towards its own subdivisions.
    """
    pulse = 30 / grid['bpm']
    offset = grid['offsetSeconds']
    by_program = defaultdict(list)
    for event in events:
        if not event['isDrum']:
            by_program[event['program']].append(event['start'])
    candidates = {}
    for program, values in by_program.items():
        attacks = _clusters(values, .022)
        residuals = [at - (offset + round((at - offset) / pulse) * pulse) for at in attacks]
        nearby = [value for value in residuals if abs(value) <= min(.06, pulse * .36)]
        if len(nearby) < 12 or len(nearby) < len(attacks) * .7:
            continue
        center = statistics.median(nearby)
        if statistics.median(abs(value - center) for value in nearby) <= .015:
            candidates[program] = center
    if len(candidates) < 2:
        return 0., []
    center = statistics.median(candidates.values())
    support = [program for program, value in candidates.items() if abs(value - center) <= .015]
    if len(support) < max(2, math.ceil(len(candidates) * 2 / 3)):
        return 0., []
    return round(statistics.median(candidates[program] for program in support), 6), sorted(support)


def _triplet_blocks(onsets: list[float], spb: float) -> dict[int, float]:
    """Require a complete three-onset pattern; never infer a tuplet from one fraction."""
    blocks = {}
    for width in (1., .5):
        step = width / 3
        candidates = defaultdict(list)
        for at in onsets:
            # Include a slightly early first attack in its intended beat.
            base = math.floor((at + min(.06 / spb, step * .4)) / width) * width
            candidates[round(base * TICKS)].append(at)
        for tick, values in candidates.items():
            base = tick / TICKS
            if len(values) != 3:
                continue
            cells = [round((at - base) / step) for at in values]
            error = sum(abs(at - (base + cell * step)) for at, cell in zip(values, cells))
            straight_error = sum(abs(at - round(at / (width / 4)) * width / 4) for at in values)
            phase = statistics.median(at - (base + i * step) for i, at in enumerate(values))
            residual = sum(abs(at - (base + i * step + phase)) for i, at in enumerate(values))
            regular_delayed = (abs(phase) * spb <= .08 and residual * spb < .045
                               and straight_error - residual > width * .08)
            if cells == [0, 1, 2] and ((error * spb < .065 and straight_error - error > width * .08)
                                     or regular_delayed):
                for half in range(round(width * 2)):
                    blocks[round(base * 2) + half] = step
    return blocks


def _turnaround_triplets(rows, spb, offset):
    """A complete returning turn plus a held metrical landing, not an odd tick.

    Real performers can delay the first of three ornamental attacks. Require
    the pitch return and a stable following note before proposing equal thirds.
    This proposal never creates or removes a pitch event.
    """
    proposal = {}
    groups = []
    for i, row in enumerate(rows):
        if groups and row[0] - rows[groups[-1][0]][0] <= .022:
            groups[-1].append(i)
        else:
            groups.append([i])
    for a, b, c, landing in zip(groups, groups[1:], groups[2:], groups[3:]):
        if any(len(group) != 1 for group in (a,b,c,landing)):
            continue
        indices = [a[0],b[0],c[0]]
        first, middle, last, final = [rows[g[0]] for g in (a,b,c,landing)]
        if first[2] != last[2] or not 0 < abs(first[2]-middle[2]) <= 2 or final[1]-final[0] < .4*spb:
            continue
        land = round((final[0]-offset)/spb*2)/2
        if abs(offset+land*spb-final[0]) > .05 or land < .5:
            continue
        base, step = land-.5, 1/6
        expected = [offset+(base+j*step)*spb for j in range(3)]
        gaps = [middle[0]-first[0],last[0]-middle[0],final[0]-last[0]]
        if (min(gaps) >= .045 and max(gaps) <= .25*spb
                and all(abs(rows[i][0]-at) <= min(.14,.15*spb) for i,at in zip(indices,expected))
                and (not proposal or all(i not in proposal for i in indices))):
            for j,i in enumerate(indices):
                proposal[i] = (base+j*step,step)
    return proposal


def _voice_assignment(notes: list[dict]) -> None:
    groups = defaultdict(list)
    for note in notes:
        groups[(round(note['start'] * TICKS), round(note['duration'] * TICKS))].append(note)
    voices = []
    for (start, duration), chord in sorted(groups.items()):
        # Equal-pitch simultaneous events are distinct sources, not a chord
        # with a duplicated pitch. Retain both in separate rhythm layers.
        layers = []
        for note in chord:
            layer = next((layer for layer in layers if all(n['midi'] != note['midi'] for n in layer)), None)
            if layer is None:
                layer = []
                layers.append(layer)
            layer.append(note)
        for layer in layers:
            pitch = statistics.mean(n['midi'] for n in layer)
            available = []
            for i, v in enumerate(voices):
                overlap = v['end'] - start
                # A small release tail may overlap the next attack in the same
                # line. Never truncate an independently sustained long note.
                if overlap > min(TICKS / 4, v['duration'] * .3, duration * .3):
                    continue
                distance = abs(v['pitch'] - pitch) / 18
                rhythm = abs(math.log2(duration / v['duration'])) * .8
                gap = min(3., abs(start - v['end']) / TICKS)
                available.append((distance + rhythm + gap, i))
            if available:
                index = min(available)[1]
                previous = voices[index]
                if previous['end'] > start:
                    for note in previous['notes']:
                        note['duration'] = round(start / TICKS - note['start'], 9)
                voices[index] = {'end': start + duration, 'pitch': pitch, 'duration': duration, 'notes': layer}
            else:
                index = len(voices)
                voices.append({'end': start + duration, 'pitch': pitch, 'duration': duration, 'notes': layer})
            for note in layer:
                note['voice'] = str(index + 1)


# Written hand allocation. A hand comfortably covers about an octave and five
# fingers; the split between hands moves gradually with the music instead of
# being fixed at middle C. These are physical/notational priors, not values
# fitted to any reference score.
HAND_REACH = 12
HAND_HARD_REACH = 16
HAND_MAX_NOTES = 5
SPLIT_MOVE_COST = .08
_SPLITS = range(36, 85)


def _hand_cost(group: list[dict], split: int, held: list[int] = ()) -> float:
    cost = .02 * abs(split - 60)
    for upper in (False, True):
        pitches = [n['midi'] for n in group if (n['midi'] >= split) == upper]
        if not pitches:
            continue
        # A key still held by the same hand limits its reach for new attacks.
        occupied = [p for p in held if (p >= split) == upper]
        span = max(pitches + occupied) - min(pitches + occupied)
        cost += 3 * max(0, span - HAND_REACH) + (25 if span > HAND_HARD_REACH else 0)
        cost += 25 if len(set(pitches)) > HAND_MAX_NOTES else 0
        # A right hand rarely plays far into the bass register, and vice versa.
        cost += sum(.5 * max(0, 55 - p) for p in pitches) if upper else sum(.5 * max(0, p - 65) for p in pitches)
    return cost


def assign_keyboard_staves(notes: list[dict]) -> None:
    """Assign written hands with a moving split point (Viterbi over attacks).

    Each compact attack group is split where both hands stay within a playable
    span; the split point changes smoothly across the piece, so a low
    right-hand melody stays in the right hand. This is a written allocation,
    not a claim to recover the pianist's physical fingering. Pitches, timing
    and note identities are never changed.
    """
    groups = []
    for note in sorted(notes, key=lambda n: (n['start'], n['midi'])):
        if groups and note['start'] - groups[-1][-1]['start'] <= .25 and note['start'] - groups[-1][0]['start'] <= .5:
            groups[-1].append(note)
        else:
            groups.append([note])
    if not groups:
        return
    def held(group):
        at = group[0]['start']
        return [n['midi'] for n in notes if n['start'] < at - 1e-6 and n['start'] + n['duration'] > at + 1e-6]
    previous = {split: _hand_cost(groups[0], split) for split in _SPLITS}
    pointers = []
    for group in groups[1:]:
        sounding = held(group)
        current, pointer = {}, {}
        # Monotone transition cost: the best predecessor of each split is
        # found with two linear sweeps instead of a quadratic search.
        best_from_below, best_from_above = {}, {}
        running = (math.inf, None)
        for split in _SPLITS:
            running = min((running[0] + SPLIT_MOVE_COST, running[1]), (previous[split], split))
            best_from_below[split] = running
        running = (math.inf, None)
        for split in reversed(_SPLITS):
            running = min((running[0] + SPLIT_MOVE_COST, running[1]), (previous[split], split))
            best_from_above[split] = running
        for split in _SPLITS:
            cost, origin = min(best_from_below[split], best_from_above[split])
            current[split] = cost + _hand_cost(group, split, sounding)
            pointer[split] = origin
        pointers.append(pointer)
        previous = current
    split = min(previous, key=lambda value: (previous[value], abs(value - 60)))
    path = [split]
    for pointer in reversed(pointers):
        split = pointer[split]
        path.append(split)
    for group, split in zip(groups, reversed(path)):
        for note in group:
            note['staff'] = 1 if note['midi'] >= split else 2


def _rolled_gesture(attacks: list[tuple[float, int]]) -> bool:
    """Measured onset evidence for a written roll, not merely onset jitter.

    A roll sweeps through the chord in pitch order with several distinct
    attacks. Unordered jitter, or a simultaneous chord with one late note, is
    written as a plain chord: the attacks are still notated together, but no
    arpeggio line is invented.
    """
    ordered = sorted(attacks, key=lambda item: item[1])
    times = [at for at, _ in ordered]
    rising = all(b >= a - ROLL_ORDER_TOLERANCE for a, b in zip(times, times[1:]))
    falling = all(b <= a + ROLL_ORDER_TOLERANCE for a, b in zip(times, times[1:]))
    distinct = len(_clusters(times, ROLL_ORDER_TOLERANCE))
    return (rising or falling) and distinct >= 3 and max(times) - min(times) >= ROLL_MIN_SPREAD


# Decoder onsets of one struck chord typically scatter by a few tens of ms.
ROLL_ORDER_TOLERANCE = .02
ROLL_MIN_SPREAD = .06
ROLL_REASONS = ('rolled_chord_notation', 'spread_chord_notation')
# Shortest written inner-voice release (an eighth note); anything closer is an ornament.
INNER_RELEASE_MINIMUM = .5
# A chord tone may share its chord's written gate when its measured release
# lies within this many seconds of it (decoder offsets are this imprecise).
CHORD_GATE_RELEASE_SLACK = .15


def _piano_rolls(notes, rows, changes, spb, offset):
    groups = []
    for index, row in enumerate(rows):
        if groups and row[0] - rows[groups[-1][-1]][0] <= min(.14, spb * .16) and row[0] - rows[groups[-1][0]][0] <= min(.40, spb * .5):
            groups[-1].append(index)
        else:
            groups.append([index])
    for indices in groups:
        if (len(indices) < 3 or len({rows[i][2] for i in indices}) != len(indices)
                or rows[indices[-1]][0] - rows[indices[0]][0] < .035
                or sum(rows[i][1] - rows[i][0] >= .45 * spb for i in indices) < math.ceil(len(indices) * .8)):
            continue
        chord = [notes[i] for i in indices]
        at = max(0., round(statistics.median((rows[i][0] - offset) / spb for i in indices) * 2) / 2)
        first_attack = rows[indices[0]][0]
        rolled = _rolled_gesture([(rows[i][0], rows[i][2]) for i in indices])
        for i in indices:
            note = notes[i]
            note['start'] = at
            if rolled:
                note['arpeggio'] = True
                note['arpeggioOffset'] = round((rows[i][0] - first_attack) / spb, 9)
            else:
                note.pop('arpeggio', None)
                note.pop('arpeggioOffset', None)
        assign_keyboard_staves(chord)
        for staff in (1, 2):
            owned = [i for i in indices if notes[i]['staff'] == staff]
            if not owned:
                continue
            following = [row[0] for j, row in enumerate(rows)
                         if j not in indices and row[0] > rows[indices[-1]][0] + .025
                         and (1 if row[2] >= 60 else 2) == staff]
            for i in owned:
                # A rolled chord shares its attack gesture, not necessarily
                # every finger's release. A median extended early releases
                # into the next bar when two other notes had pedal tails.
                release = (rows[i][1] - offset) / spb
                if following:
                    release = min(release, (min(following) - offset) / spb)
                length = max(.5, round((release - at) * 2) / 2)
                notes[i]['duration'] = length
                changes[i].update(reason='rolled_chord_notation' if rolled else 'spread_chord_notation',
                                  scoreStartSeconds=offset + at * spb,
                                  scoreEndSeconds=offset + (at + length) * spb)


def _joint_onsets(onsets, quantum, spb, weights):
    """Viterbi on a small rhythmic lattice; do not collapse successive attacks."""
    states = {None: (0., None)}
    previous = None
    for index, at in enumerate(onsets):
        step = quantum(at)
        center = round(at / step)
        candidates = [max(0., (center + delta) * step) for delta in (-1, 0, 1)]
        # Finer conventional subdivisions are available for a real accelerating
        # run; a complexity cost keeps them out of regular passages.
        fine = step / 2 if step == .125 else step
        if fine != step:
            candidates += [max(0., (round(at / fine) + delta) * fine) for delta in (-1, 0, 1)]
        updated = {}
        for q in set(candidates):
            options = []
            for prior, (cost, path) in states.items():
                if prior is not None and q <= prior + 1e-6:
                    continue
                penalty = 0.
                if prior is not None and at - previous < 4:
                    unit = min(step, quantum(previous))
                    expected = max(unit, round((at - previous) / unit) * unit)
                    penalty = 2 * ((q - prior - expected) / unit) ** 2
                complexity = 1.5 if abs(q / step - round(q / step)) > 1e-6 else 0.
                options.append((cost + penalty + complexity + weights[index] * ((q - at) * spb / .04) ** 2, (q, path)))
            if options:
                updated[q] = min(options, key=lambda v: v[0])
        if not updated:
            raise ValueError('Rhythmic lattice cannot preserve successive attacks')
        states, previous = updated, at
    path = min(states.values(), key=lambda v: v[0])[1]
    result = []
    while path is not None:
        result.append(path[0])
        path = path[1]
    return result[::-1]


def _pedal_hold(note, change, at, following, owned, starts, spb, offset, pedals):
    """Written end for an inner note held under a measured pedal, or None.

    Both evidence paths must hold over the whole extension: a ByteDance pedal
    interval covers it, and the note's own refined measured release reaches
    it (within the chord-gate release tolerance). The end snaps down to an
    existing same-hand attack, never beyond the current written length.
    """
    E = 1e-6
    if not pedals or change is None or spb is None:
        return None
    seconds = lambda beat: offset + beat * spb
    release = change['sourceEndSeconds'] + CHORD_GATE_RELEASE_SLACK
    cover = next((p for p in pedals if p['onset_time'] <= seconds(following) + E
                  and p['offset_time'] > seconds(following)), None)
    if cover is None:
        return None
    end = note['start'] + note['duration']
    same_pitch = min((n['start'] for n, _ in owned if n['midi'] == note['midi'] and n['start'] > at + E), default=end)
    limit = min(end, same_pitch)
    candidates = [t for t in starts if following < t <= limit + E] + ([end] if end <= limit + E else [])
    allowed = [t for t in candidates if seconds(t) <= release + E and seconds(t) <= cover['offset_time'] + E]
    return max(allowed) if allowed else None


def _second_voice_free(layer, at, kept):
    """The second written voice can take a note from `at` to `kept`."""
    E = 1e-6
    for n in layer:
        n_end = n['start'] + n['duration']
        if n['start'] < at - E and n_end > at + E:
            return False
        if abs(n['start'] - at) < E and abs(n_end - kept) > E:
            return False
    return True


def keyboard_voices(notes: list[dict], changes: list[dict] | None = None,
                    spb: float | None = None, offset: float = 0.,
                    pedals: list[dict] | None = None) -> None:
    """At most two written voices per hand: a main voice plus one outer line.

    A note held past the hand's next attack stays sustained only when it is
    the hand's outer edge (lowest note of the left hand, highest of the right),
    optionally with chord tones released together with it, and only until the
    hand next attacks in that outer register. It is never written longer than
    its existing measured length. Other notes that would overlap the next
    attack in the same hand are written up to that attack; acoustic releases
    remain in the audit. No attack, pitch or note is added or removed.
    """
    E = 1e-6
    changes = changes if changes is not None else [None] * len(notes)
    for staff in (1, 2):
        owned = [(n, c) for n, c in zip(notes, changes) if n.get('staff') == staff]
        by_start = defaultdict(list)
        for item in owned:
            by_start[item[0]['start']].append(item)
        starts = sorted(by_start)
        outer = []
        # Lower notes are "inside" the left hand when they lie above the
        # held bass; for the right hand, below the held top note.
        inside = (lambda n, ref: n['midi'] > ref) if staff == 2 else (lambda n, ref: n['midi'] < ref)
        for index, at in enumerate(starts):
            following = starts[index + 1] if index + 1 < len(starts) else None
            # Outer edge first, so its chord partners see its final length.
            chord = sorted(by_start[at], key=lambda item: item[0]['midi'], reverse=staff == 1)
            held_until, held_length, seen = None, None, set()
            for position, (note, change) in enumerate(chord):
                if note['midi'] in seen:
                    # Equal-pitch simultaneous events are distinct sources;
                    # a second layer keeps both written instead of merging.
                    note['voice'] = '2'
                    continue
                seen.add(note['midi'])
                end = note['start'] + note['duration']
                if following is None or end <= following + E:
                    note['voice'] = '1'
                    continue
                spanned = [n for n, _ in owned if at < n['start'] < end - E]
                crossing = min((n['start'] for n in spanned if not inside(n, note['midi'])), default=end)
                is_edge = position == 0
                partner = (held_until is not None and abs(note['duration'] - held_length) < E
                           and crossing >= held_until - E)
                if (is_edge and crossing > following + E) or partner:
                    stop = crossing if is_edge else held_until
                    if is_edge:
                        held_until, held_length = stop, note['duration']
                    if stop < end - E:
                        note['duration'] = round(stop - at, 9)
                        if change is not None:
                            change['reason'] = 'keyboard_outer_voice_release'
                    note['voice'] = '2'
                    outer.append(note)
                    continue
                if following - at < INNER_RELEASE_MINIMUM - E:
                    # A grace-like attack right after the chord is not a
                    # rhythmic release point; never shrink a held note to a
                    # sliver. Keep it, with its own length, in the second layer.
                    note['voice'] = '2'
                    continue
                kept = _pedal_hold(note, change, at, following, owned, starts, spb, offset, pedals)
                if kept is not None and _second_voice_free(outer, at, kept):
                    if kept < end - E:
                        note['duration'] = round(kept - at, 9)
                    note['voice'] = '2'
                    outer.append(note)
                    if change is not None:
                        change['reason'] = 'keyboard_pedal_inner_hold'
                    continue
                note['duration'] = round(following - at, 9)
                note['voice'] = '1'
                if change is not None:
                    change['reason'] = 'keyboard_inner_voice_release'
        # A main-voice chord shares one written gate: chord tones that release
        # before the hand's next attack still sound until it is struck, so a
        # split "short + long" chord does not need a third rhythm layer. Only
        # applied when the longest tone already reaches the next attack.
        for index, at in enumerate(starts):
            main = [n for n, _ in by_start[at] if n.get('voice') == '1']
            following = starts[index + 1] if index + 1 < len(starts) else None
            if len(main) < 2 or following is None:
                continue
            gate = max(n['duration'] for n in main)
            if abs(at + gate - following) > E:
                continue
            for note, change in by_start[at]:
                if note.get('voice') == '1' and note['duration'] < gate - E:
                    # Acoustic evidence: the measured release must already
                    # reach most of the way to the shared gate.
                    if change is None or spb is None or (
                            change['sourceEndSeconds'] < offset + (at + gate) * spb - CHORD_GATE_RELEASE_SLACK):
                        continue
                    note['duration'] = gate
                    if change is not None:
                        change['reason'] = 'keyboard_shared_chord_gate'
        # The outer line is itself one rhythm: a later outer attack ends the
        # previous one rather than stacking a third independent layer.
        for previous in outer:
            later = [n['start'] for n in outer
                     if previous['start'] < n['start'] < previous['start'] + previous['duration'] - E]
            if later:
                previous['duration'] = round(min(later) - previous['start'], 9)


def _keyboard_written_releases(notes, changes, spb, offset):
    """Resolve releases after rolled attacks have their final written position."""
    assign_keyboard_staves(notes)
    for staff in (1,2):
        owned = [(n,c) for n,c in zip(notes,changes) if n['staff']==staff]
        starts = sorted(set(n['start'] for n,_ in owned))
        following = dict(zip(starts,starts[1:]))
        for note,change in owned:
            target = following.get(note['start'])
            if (target is not None and change['reason'] not in ROLL_REASONS and target-note['start']<=2
                    and abs(change['sourceEndSeconds']-(offset+target*spb))<=.12):
                # The old global next-attack map cut an RH eighth at an early
                # LH roll, before that roll was moved onto the written beat.
                note['duration']=round(target-note['start'],9)
                change.update(reason='same_hand_written_release',scoreEndSeconds=offset+target*spb)
        if staff != 2 or not starts:
            continue
        last = starts[-1]
        terminal_roll = [(n,c) for n,c in owned if n['start']==last and c['reason'] in ROLL_REASONS]
        if len(terminal_roll)<2:
            continue
        boundary=(math.floor(last/4)+1)*4
        high_handoff=[n for n in notes if n['staff']==1 and abs(n['start']-boundary)<=.125
                      and n['midi']>=max(x['midi'] for x,_ in terminal_roll)+12]
        if not high_handoff:
            continue
        for note,change in terminal_roll:
            if note['start']+note['duration']>boundary+1:
                note['duration']=round(boundary-note['start'],9)
                change.update(reason='terminal_keyboard_handoff',scoreEndSeconds=offset+boundary*spb)


def infer_part_rhythm(events: list, grid: dict, duration: float, part_id: str,
                      *, percussion: bool = False, program: int = 0,
                      pedals: list[dict] | None = None) -> tuple[list[dict], dict]:
    bpm, offset = float(grid['bpm']), float(grid['offsetSeconds'])
    if not all(math.isfinite(v) for v in (bpm, offset, duration)) or not 20 <= bpm <= 300 or duration <= 0:
        raise ValueError('Invalid musical score grid')
    spb = 60 / bpm
    rows, outside = [], 0
    for event in events:
        start, end, pitch, velocity = map(float, event[:4])
        if (not all(math.isfinite(v) for v in (start, end, pitch, velocity)) or start < 0
                or end <= start or pitch != int(pitch) or not 0 <= pitch <= 127):
            raise ValueError('Invalid musical score event')
        if start >= duration:
            outside += 1
            continue
        rows.append((start, min(end, duration), int(pitch), max(.01, min(1., velocity))))
    rows.sort(key=lambda r: (r[0], r[2], r[1]))
    onsets = _clusters([(r[0] - offset) / spb for r in rows], .022 / spb)
    triplets = {} if percussion else _triplet_blocks(onsets, spb)
    hand_triplets, hand_points = {}, {}
    if program in (0,2) and not percussion:
        # An attack in the other hand must not invalidate this hand's complete
        # triplet. Held basses/chords still retain their own onset and duration.
        for high in (False,True):
            hand_rows = [r for r in rows if (r[2]>=60)==high]
            hand_onsets = _clusters([(r[0]-offset)/spb for r in hand_rows], .022/spb)
            hand_triplets[high] = _triplet_blocks(hand_onsets, spb)
            for half, step in list(hand_triplets[high].items()):
                local = [r for r in hand_rows if math.floor(((r[0]-offset)/spb+min(.06/spb,.06))*2)==half]
                # Onset thirds alone cannot explain overlapping held notes.
                # Until those releases form a coherent phrase, prefer the
                # conventional fallback to several isolated tuplet brackets.
                if not local or any(r[1]-r[0]>1.5*step*spb+.04 for r in local):
                    del hand_triplets[high][half]
            hand_points[high] = {round(at*TICKS):hand_triplets[high][half]
                for at in hand_onsets
                if (half:=math.floor((at+min(.06/spb,.06))*2)) in hand_triplets[high]}
        triplets = {}  # interleaved hands are not one three-note phrase
    turns = _turnaround_triplets(rows,spb,offset) if program in (0,2) and not percussion else {}
    bars = defaultdict(list)
    # Half-bar phrases allow a regular run and its quicker ending to use
    # different grids, without making the entire measure equally fine.
    bar_at = lambda at: max(0, math.floor((at + .035 / spb) / 2))
    for onset in onsets:
        bars[bar_at(onset)].append(onset)
    steps = {}
    pattern_bars = []
    for bar, values in bars.items():
        straight = [v for v in values if math.floor((v + 1e-7) * 2) not in triplets]
        chosen = .125  # ordinary 32nd notes, not arbitrary rational remainders
        for step in (1., .5, .25, .125):
            errors = sorted(abs(v - round(v / step) * step) * spb for v in straight)
            shortest = min((b - a for a, b in zip(straight, straight[1:])), default=step)
            intervals = [abs((b - a) - round((b - a) / step) * step) * spb
                         for a, b in zip(straight, straight[1:])]
            pattern = (len(intervals) >= 3 and statistics.median(intervals) <= .025
                       and max(intervals) <= .09 and statistics.mean(errors) <= .075
                       and errors[min(len(errors) - 1, math.floor(len(errors) * .9))] <= .09)
            exact = not errors or (statistics.mean(errors) <= .035
                                   and errors[min(len(errors) - 1, math.floor(len(errors) * .9))] <= .035)
            if not errors or (shortest >= step * .65 and (exact or pattern)):
                chosen = step
                if pattern and not exact:
                    pattern_bars.append(bar)
                break
        steps[bar] = chosen

    def quantum(at):
        # Account for slightly early attacks at triplet block boundaries.
        half = math.floor((at + min(.06 / spb, .06)) * 2)
        own = [step for points in hand_points.values() for tick,step in points.items()
               if abs(at-tick/TICKS)<=.022/spb]
        return own[0] if own else triplets.get(half, steps.get(bar_at(at), .25))

    def duration_quantum(at,pitch):
        if hand_points:
            own = [step for tick,step in hand_points[pitch>=60].items() if abs(at-tick/TICKS)<=.022/spb]
            if own:
                return own[0]
        half = math.floor((at+min(.06/spb,.06))*2)
        return triplets.get(half,steps.get(bar_at(at),.25))

    cluster_indices = []
    for row in rows:
        at = (row[0] - offset) / spb
        right = bisect_left(onsets, at)
        cluster_indices.append(min((max(0, right - 1), min(len(onsets) - 1, right)), key=lambda i: abs(onsets[i] - at)))
    weights = [1.] * len(onsets)
    for row, index in zip(rows, cluster_indices):
        if row[1] - row[0] > .5 * spb:
            weights[index] += 4
    quantized = _joint_onsets(onsets, quantum, spb, weights)
    starts = [quantized[index] for index in cluster_indices]
    for index, row in enumerate(rows):
        raw_beat = (row[0] - offset) / spb
        raw_length = (row[1] - row[0]) / spb
        # The held-note layer has its own pulse. A fast ornamental run must
        # not drag its accompaniment onto 32nd/64th-note anticipation ticks.
        if raw_length >= .75 and quantum(raw_beat) <= .125:
            pulse = round(raw_beat * 2) / 2
            if abs(pulse - raw_beat) <= .18:
                starts[index] = max(0., pulse)
    for index,(at,_) in turns.items():
        starts[index] = at
    attacks = sorted(set(round(at * TICKS) for at in starts))
    next_attack = dict(zip(attacks, attacks[1:]))
    previous_attack = dict(zip(attacks[1:], attacks))
    actual_at = defaultdict(list)
    for row, at in zip(rows, starts):
        actual_at[round(at * TICKS)].append(row[0])
    gates = []
    for row, at in zip(rows, starts):
        tick = round(at * TICKS)
        if tick in next_attack:
            gap = (next_attack[tick] - tick) / TICKS * spb
            if .10 <= gap <= spb * 1.1:
                gates.append((row[1] - row[0]) / gap)
    percussive_timbre = program in (0, 2, 8, 24, 26, 29, 32, 33)
    detached_pattern = (not percussion and len(gates) >= 6
                        and .08 <= statistics.median(gates) <= .65)
    notes, changes = [], []
    for index, (row, a) in enumerate(zip(rows, starts), 1):
        start, end, pitch, velocity = row
        raw_beat = (start - offset) / spb
        step = duration_quantum(raw_beat,pitch)
        tick = round(a * TICKS)
        next_tick = next_attack.get(tick)
        raw_duration = (end - start) / spb
        length_step = step if abs(step * 16 - round(step * 16)) > 1e-6 else min(step, .125)
        lengths = [length_step * k for k in (1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128)]
        while lengths[-1] < raw_duration:
            lengths.append(lengths[-1] * 2)
        if percussive_timbre and length_step in (.0625, .125):
            lengths = [value for value in lengths if value >= .5 or value in (.0625, .125, .25)]
        # Prefer conventional written lengths, instead of copying the release
        # phase into awkward 5/32 or 7/32 durations.
        length = min(lengths, key=lambda value: abs(value - raw_duration))
        b = a + length
        articulation = None
        reason = 'rhythm_grid'
        if next_tick is not None:
            following = next_tick / TICKS
            actual_next = statistics.median(actual_at[next_tick])
            gap = (following - a) * spb
            release_delta = end - actual_next
            near_release = abs(release_delta) <= min(.12, max(.045, gap * .35))
            short_gate = detached_pattern and following - a <= 1.01 and end < actual_next
            if percussion or ((near_release or short_gate) and following - a <= 2):
                b = following if not percussion else min(a + 1., following)
                reason = 'hit_rhythm' if percussion else 'release_to_next_attack'
                if not percussion and release_delta < -.035:
                    articulation = 'staccato'
                    if short_gate and following - a >= .5 and (end - start) / gap < .3:
                        b = a + (following - a) / 2
                        reason = 'short_staccato_with_rest'
        elif percussion:
            b = a + .5
            reason = 'hit_rhythm'
        if detached_pattern and (next_tick is None or next_tick / TICKS - a > 2):
            # The last hit of a detached phrase has no nearby successor.
            # Continue its established rhythm instead of reverting to the
            # short acoustic release and printing a lone 32nd-note chord.
            prior = previous_attack.get(tick)
            if prior is not None:
                prior_gap = a - prior / TICKS
                ratio = raw_duration / prior_gap
                if .25 <= prior_gap <= 1 and .08 <= ratio <= .65:
                    b = a + prior_gap / (2 if prior_gap >= .5 and ratio < .3 else 1)
                    articulation = 'staccato'
                    reason = 'detached_phrase_end'
        n = {'id': f'{part_id}-q{index}', 'midi': pitch, 'start': round(a, 9),
             'duration': round(b - a, 9), 'velocity': velocity, 'origin': 'transcribed'}
        if articulation:
            n['articulation'] = articulation
        if percussion:
            n['lyric'] = 'dum' if pitch in (35, 36) else 'ka' if pitch in (37, 38, 39, 40) else 'ts'
        notes.append(n)
        changes.append({'noteId': n['id'], 'sourceStartSeconds': start, 'sourceEndSeconds': end,
                        'scoreStartSeconds': offset + a * spb, 'scoreEndSeconds': offset + b * spb,
                        'reason': reason, 'articulation': articulation})
    for index, (at, length) in turns.items():
        notes[index].update(start=round(at,9),duration=round(length,9))
        notes[index].pop('articulation',None)
        changes[index].update(reason='returning_turn_triplet',scoreStartSeconds=offset+at*spb,
                              scoreEndSeconds=offset+(at+length)*spb,articulation=None)
    if not percussion:
        # Chord tones often have slightly different detected releases. Let a
        # coherent chord share its written gate rather than create extra
        # rhythm voices at a staccato/rest decision boundary. Long held tones
        # remain separate because their acoustic releases are not clustered.
        by_attack = defaultdict(list)
        for note, change in zip(notes, changes):
            by_attack[round(note['start'] * TICKS)].append((note, change))
        for chord in by_attack.values():
            release_groups = []
            for item in sorted(chord, key=lambda item: item[1]['sourceEndSeconds']):
                if release_groups and item[1]['sourceEndSeconds'] - release_groups[-1][0][1]['sourceEndSeconds'] <= .04:
                    release_groups[-1].append(item)
                else:
                    release_groups.append([item])
            for group in release_groups:
                if len(group) < 2 or max(c['sourceStartSeconds'] for _, c in group) - min(c['sourceStartSeconds'] for _, c in group) > .022:
                    continue
                center = statistics.median(c['sourceEndSeconds'] for _, c in group)
                representative = min(group, key=lambda item: (abs(item[1]['sourceEndSeconds'] - center), -item[0]['duration']))[0]
                length, articulation = representative['duration'], representative.get('articulation')
                for note, change in group:
                    if note['duration'] != length or note.get('articulation') != articulation:
                        note['duration'] = length
                        if articulation:
                            note['articulation'] = articulation
                        else:
                            note.pop('articulation', None)
                        change.update(reason='shared_chord_release', articulation=articulation,
                                      scoreEndSeconds=offset + (note['start'] + length) * spb)
    if program in (0, 2) and not percussion:
        _piano_rolls(notes, rows, changes, spb, offset)
        _keyboard_written_releases(notes,changes,spb,offset)
    rapid = [n for n in notes if n['duration'] <= .25]
    sustained = [n for n in notes if n['duration'] >= .75]
    if len(rapid) >= max(16, len(notes) * .25) and len(sustained) >= 8 and not percussion:
        # Joint decoders can put several instruments of the same class in one
        # part. Stable rhythmic layers keep the run out of the held-note line.
        layers = defaultdict(list)
        for note in notes:
            layer = 'run' if note['duration'] <= .25 else 'low' if note['midi'] < 60 else 'held'
            layers[layer].append(note)
        for layer, subset in layers.items():
            if layer == 'run':
                run_starts = sorted(set(n['start'] for n in subset))
                following = dict(zip(run_starts, run_starts[1:]))
                for note in subset:
                    gap = following.get(note['start'], float('inf')) - note['start']
                    if gap <= .25 or (gap <= .5 and note['duration'] >= gap * .6):
                        if gap > note['duration'] * 1.4:
                            note['articulation'] = 'staccato'
                        note['duration'] = round(gap, 9)
            _voice_assignment(subset)
            if layer == 'held' and percussive_timbre:
                voice_groups = defaultdict(list)
                for note in subset:
                    voice_groups[note['voice']].append(note)
                for voice in voice_groups.values():
                    times = sorted(set(n['start'] for n in voice))
                    following = dict(zip(times, times[1:]))
                    for note in voice:
                        gap = following.get(note['start'], float('inf')) - note['start']
                        if gap <= 1 and .25 <= note['duration'] / gap <= .8:
                            note['duration'] = gap
                            note['articulation'] = 'staccato'
            for note in subset:
                note['voice'] = f'{layer}-{note["voice"]}'
                note['staff'] = 2 if layer == 'low' else 1
    else:
        _voice_assignment(notes)
        if notes and not percussion and (program in (0, 2) or (
                program in (8, 16, 24, 26, 29, 46) and len(set(n['voice'] for n in notes)) > 2
                and min(n['midi'] for n in notes) < 55 and max(n['midi'] for n in notes) >= 64)):
            # Assign within each written register, rather than duplicating all
            # global voices onto both staves after a keyboard/chord split.
            for staff in (1, 2):
                subset = [n for n in notes if (1 if n['midi'] >= 60 else 2) == staff]
                _voice_assignment(subset)
                for note in subset:
                    note['staff'] = staff
    if program in (0, 2) and not percussion:
        assign_keyboard_staves(notes)
        keyboard_voices(notes, changes, spb, offset, pedals)
    for note, change in zip(notes, changes):
        actual_end = offset + (note['start'] + note['duration']) * spb
        if abs(actual_end - change['scoreEndSeconds']) > 1e-6:
            if not change['reason'].startswith('keyboard_'):
                change['reason'] = 'voice_written_gate'
            change['scoreEndSeconds'] = actual_end
            change['articulation'] = note.get('articulation')
    return notes, {'version': VERSION, 'inputEvents': len(events), 'outputNotes': len(notes),
                   'outsideAnalysisEvents': outside, 'editorialTiming': True,
                   'rhythmicStepsByHalfBar': steps, 'tripletHalfBeats': sorted(set(triplets).union(
                       *(set(blocks) for blocks in hand_triplets.values()))),
                   'handTripletHalfBeats': {str(hand):sorted(blocks) for hand,blocks in hand_triplets.items()},
                   'ornamentTripletGroups': len(turns)//3,
                   'intervalPatternHalfBars': pattern_bars,
                   'detachedPattern': detached_pattern, 'noAttackDeduplication': True,
                   'maximumOnsetShiftSeconds': max((abs(c['scoreStartSeconds'] - c['sourceStartSeconds']) for c in changes), default=0),
                   'maximumOffsetShiftSeconds': max((abs(c['scoreEndSeconds'] - c['sourceEndSeconds']) for c in changes), default=0),
                   'boundaryChanges': changes}

"""Turn acoustic vocal events into a rhythmic score, retaining an edit audit.

Pitch decoding and notation are separate: missing pitch frames are not new
syllables, and sub-beat articulation gaps need not become printed rests.
"""
from __future__ import annotations

import math

import numpy as np

VERSION = "vocal-score-joint-rhythm-3"


def clean_vocal_fragments(events: list, times, f0, features: dict) -> tuple[list, dict]:
    times, f0 = np.asarray(times), np.asarray(f0)
    attack = np.asarray(features["attack"])
    if times.ndim != 1 or f0.shape != times.shape or attack.shape != times.shape:
        raise ValueError("Invalid vocal evidence shape")
    if not np.all(np.isfinite(times)) or np.any(np.diff(times) <= 0):
        raise ValueError("Vocal evidence times must increase")
    source = [list(map(float, event[:4])) for event in events]
    if any(len(event) != 4 or not all(math.isfinite(x) for x in event) or event[1] <= event[0] for event in source):
        raise ValueError("Invalid vocal events")
    if any(left[1] > right[0] + 1e-7 for left, right in zip(source, source[1:])):
        raise ValueError("Vocal events must be monophonic and ordered")
    output, edits = [], []

    def attack_at(seconds):
        mask = (times >= seconds - .025) & (times <= seconds + .025)
        return float(np.max(attack[mask], initial=0.))

    def stable_platform(event):
        mask = (times >= event[0] + .015) & (times < event[1] - .015) & (f0 > 0) & np.isfinite(f0)
        midi = 69 + 12 * np.log2(f0[mask] / 440)
        return len(midi) >= 4 and np.quantile(midi, .9) - np.quantile(midi, .1) <= .24 and np.mean(np.abs(midi - event[2]) <= .25) >= .7

    for index, event in enumerate(source):
        previous = output[-1] if output else None
        following = source[index + 1] if index + 1 < len(source) else None
        if previous and previous[2] == event[2] and -.000001 <= event[0] - previous[1] <= .065 and attack_at(event[0]) < .35:
            # At least one side must be a fragment: stable repeated syllables
            # cannot be joined merely because their pitch happens to agree.
            if min(previous[1] - previous[0], event[1] - event[0]) <= .085:
                edits.append({"kind": "same_pitch_dropout", "source": [previous.copy(), event.copy()], "reason": "Short same-pitch fragment, <=65ms gap and no independent acoustic reattack"})
                previous[1] = event[1]
                previous[3] = max(previous[3], event[3])
                continue
        if event[1] - event[0] < .045 and attack_at(event[0]) < .45:
            if following and following[2] == event[2] and following[0] - event[1] <= .065 and attack_at(following[0]) < .35:
                output.append(event)
                continue
            edits.append({"kind": "unsupported_micro_island", "source": [event.copy()], "reason": "<45ms isolated pitch island without a distinct attack; retained in acoustic evidence, not notated as a syllable"})
            continue
        output.append(event)

    index = 1
    while index + 1 < len(output):
        previous, event, following = output[index - 1:index + 2]
        if (previous[2] == following[2] and 0 < abs(previous[2] - event[2]) <= 1
                and event[0] - previous[1] <= .04 and following[0] - event[1] <= .04
                and event[1] - event[0] <= .135 and attack_at(event[0]) < .35
                and attack_at(following[0]) < .35 and not stable_platform(event)):
            edits.append({"kind": "unstable_neighbor_return", "source": [previous.copy(), event.copy(), following.copy()],
                          "reason": "Fast semitone return without reattack or stable destination platform; retain the sustained pitch target"})
            previous[1], previous[3] = following[1], max(previous[3], following[3])
            del output[index:index + 2]
            index = max(1, index - 1)
        else:
            index += 1
    return output, {"inputEvents": len(source), "outputEvents": len(output), "edits": edits,
                    "claimsPitchTruth": False, "preservesStrongRepeatedAttacks": True}


def _select_joint_rhythm_path(rows: list, all_options: list, spb: float) -> list:
    """Choose a collision-free path, sharing the maximum feasible boundaries."""
    totals = [np.asarray([choice[2] for choice in all_options[0]])]
    # Minimize broken touching boundaries before rhythmic complexity. A shared
    # acoustic boundary is one event in time, not two independent rounding jobs.
    # The extra DP objective also provides a bounded-choice fallback: if no path
    # can share every boundary, retain every attack and break the fewest possible
    # junctions rather than failing or relaxing all continuity constraints.
    broken_boundaries = [np.zeros(len(all_options[0]))]
    pointers = [np.full(len(all_options[0]), -1, dtype=int)]
    for index in range(1, len(rows)):
        previous = all_options[index - 1]
        raw_gap = max(0., rows[index][0] - rows[index - 1][1])
        # A voiced syllable's release precedes the next attack. Notating every
        # brief articulation release as a rest obscures the sung rhythm.
        connected = raw_gap <= min(.10, .2 * spb)
        touching = raw_gap <= 1e-7
        real_rest = raw_gap >= .18
        next_options, prev_options = np.asarray(all_options[index]), np.asarray(previous)
        gaps = (next_options[:, 0, None] - prev_options[None, :, 1]) * spb
        allowed = gaps >= -1e-7
        if real_rest:
            allowed &= gaps >= max(min(.30, raw_gap), raw_gap - .12) - 1e-7
        breaks = np.where(allowed, broken_boundaries[-1][None, :] + (touching & (gaps > 1e-7)), np.inf)
        fewest_breaks = np.min(breaks, axis=1)
        continuity = np.where((gaps > 1e-7) & connected, 1.8 + np.minimum(2., gaps / spb * 2), 0.)
        costs = np.where(allowed & (breaks == fewest_breaks[:, None]), totals[-1][None, :] + continuity, np.inf)
        back = np.argmin(costs, axis=1)
        current = costs[np.arange(len(next_options)), back] + next_options[:, 2]
        totals.append(current)
        broken_boundaries.append(fewest_breaks)
        pointers.append(back)
    fewest_breaks = np.min(broken_boundaries[-1])
    choice = int(np.argmin(np.where(broken_boundaries[-1] == fewest_breaks, totals[-1], np.inf)))
    if not np.isfinite(totals[-1][choice]):
        # The caller can retain the unquantized evidence rather than silently
        # collapsing two real attacks into one by-start dictionary entry.
        raise ValueError("No collision-free vocal rhythm path")
    selected = [None] * len(rows)
    for index in range(len(rows) - 1, -1, -1):
        selected[index] = all_options[index][choice]
        choice = int(pointers[index][choice])
    return selected


def quantize_vocal_rhythm(events: list, grid: dict, duration: float, part_id: str = "vocals", *, preserve_confidence: bool = True) -> tuple[list[dict], dict]:
    """Joint onset/offset path with rhythmic cost and explicit rest preservation.

    The path cannot deduplicate colliding attacks. A 32nd grid is available for
    genuine fast notes, but costs more than simple metrical positions. Touching
    notes share boundaries whenever the bounded candidates permit it; any
    minimum-break fallback is audited. Real breaths remain separate states.
    """
    bpm, offset = float(grid["bpm"]), float(grid["offsetSeconds"])
    if not all(math.isfinite(v) for v in (bpm, offset, duration)) or not 20 <= bpm <= 300 or duration <= 0:
        raise ValueError("Invalid vocal rhythm grid")
    spb = 60 / bpm
    rows = []
    for event in events:
        if len(event) < 4:
            raise ValueError("Vocal event needs onset, offset, pitch and strength")
        row = list(map(float, event[:4]))
        if (not all(math.isfinite(v) for v in row) or row[0] < 0 or row[1] <= row[0]
                or not 0 <= row[2] <= 127 or row[2] != int(row[2])):
            raise ValueError("Invalid vocal event")
        if row[0] < duration:
            row[1] = min(row[1], duration)
            rows.append(row)
    if any(a[1] > b[0] + 1e-7 for a, b in zip(rows, rows[1:])):
        raise ValueError("Ordered monophonic vocal events required")
    if not rows:
        return [], {"version": VERSION, "inputEvents": 0, "outputNotes": 0, "boundaryChanges": []}

    def complexity(beat):
        for step, cost in ((1., 0.), (.5, .08), (.25, .24), (.125, 1.05), (.0625, 3.), (.03125, 5.)):
            if abs(beat / step - round(beat / step)) < 1e-6:
                return cost
        return 7.

    def candidates(seconds, tolerance):
        beat = max(0., (seconds - offset) / spb)
        options = {}
        for step in (.5, .25, .125, .0625, .03125):
            center = round(beat / step)
            for point in (max(0., (center - 1) * step), max(0., center * step), max(0., (center + 1) * step)):
                shift = abs(point - beat) * spb
                if shift <= tolerance + 1e-8:
                    options[point] = (shift / max(.025, tolerance)) ** 2 * .85 + complexity(point)
        if not options:
            point = round(beat / .125) * .125
            options[point] = ((point - beat) * spb / tolerance) ** 2 + complexity(point)
        return options

    all_options = []
    for start, end, pitch, strength in rows:
        length = min(end, duration) - start
        tolerance = min(.11, .22 * spb, max(.035, length * .42))
        starts, ends = candidates(start, tolerance), candidates(min(end, duration), max(tolerance, min(.11, .22 * spb)))
        choices = []
        for left, start_cost in starts.items():
            for right, end_cost in ends.items():
                if right < left + .03125 - 1e-8:
                    continue
                duration_beats = right - left
                duration_cost = complexity(duration_beats) * .45
                if duration_beats < .125:
                    duration_cost += 5.
                choices.append((left, right, start_cost + end_cost * .75 + duration_cost))
        if not choices:
            left = round(max(0., (start - offset) / spb) / .125) * .125
            choices = [(left, left + .125, 6.)]
        all_options.append(choices)

    selected = _select_joint_rhythm_path(rows, all_options, spb)
    touching_boundaries = [index for index in range(1, len(rows)) if rows[index][0] - rows[index - 1][1] <= 1e-7]
    unshared = [{"beforeEvent": index, "afterEvent": index + 1,
                 "sourceBoundarySeconds": rows[index][0],
                 "scoreGapSeconds": (selected[index][0] - selected[index - 1][1]) * spb}
                for index in touching_boundaries if selected[index][0] - selected[index - 1][1] > 1e-7]
    notes, changes = [], []
    for index, (event, (start, end, _)) in enumerate(zip(rows, selected), 1):
        original_start, original_end, pitch, strength = event
        notes.append({"id": f"{part_id}-r{index}", "midi": int(pitch), "start": round(start, 6), "duration": round(end - start, 6),
                      "velocity": round(float(np.clip(strength, .18, 1)), 4), "origin": "transcribed"})
        if preserve_confidence:
            notes[-1]["confidence"] = round(float(np.clip(strength, 0, 1)), 4)
        changes.append({"sourceStartSeconds": original_start, "sourceEndSeconds": original_end,
                        "scoreStartSeconds": offset + start * spb, "scoreEndSeconds": offset + end * spb})
    return notes, {"version": VERSION, "inputEvents": len(rows), "outputNotes": len(notes), "noAttackDeduplication": True,
                   "maximumOnsetShiftSeconds": max(abs(x["scoreStartSeconds"] - x["sourceStartSeconds"]) for x in changes),
                   "maximumOffsetShiftSeconds": max(abs(x["scoreEndSeconds"] - x["sourceEndSeconds"]) for x in changes),
                   "boundaryChanges": changes, "minimumRestPreservedSeconds": .18,
                   "touchingBoundaries": len(touching_boundaries),
                   "sharedTouchingBoundaries": len(touching_boundaries) - len(unshared),
                   "touchingBoundaryFallback": bool(unshared), "unsharedTouchingBoundaries": unshared,
                   "method": "Joint metrical onset/offset path; shared touching boundaries before rhythmic cost, minimum-break fallback, and true rest states"}

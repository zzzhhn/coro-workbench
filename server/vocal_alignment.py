"""Align learned singing-note boundaries to local acoustic evidence.

ROSVOT predicts syllable boundaries, which can precede the pitched vowel. This
step retains its event sequence and uses a second pitch track and actual attacks
to refine boundaries; it never applies a reference-derived global delay.
"""
from __future__ import annotations

import copy
import math

import numpy as np
from scipy.ndimage import median_filter
from scipy.signal import find_peaks

VERSION = "learned-note-acoustic-alignment-1"


def align_vocal_notes(events: list[dict], times, f0, activation, features: dict) -> tuple[list[dict], dict]:
    times, f0, activation = (np.asarray(values, dtype=float) for values in (times, f0, activation))
    if (times.ndim != 1 or len(times) < 2 or times.shape != f0.shape or activation.shape != times.shape
            or not np.isfinite(times).all() or np.any(np.diff(times) <= 0)):
        raise ValueError("Invalid alignment pitch track")
    attack = np.asarray(features['attack'])
    rms = np.asarray(features['rms'])
    if attack.shape != times.shape or rms.shape != times.shape:
        raise ValueError("Invalid acoustic feature shape")
    source = copy.deepcopy(events)
    if any(not all(math.isfinite(event[key]) for key in ('source_start_seconds', 'source_end_seconds'))
           or event['source_end_seconds'] <= event['source_start_seconds'] for event in source):
        raise ValueError("Invalid learned vocal intervals")
    if any(a['source_end_seconds'] > b['source_start_seconds'] + 1e-6 for a, b in zip(source, source[1:])):
        raise ValueError("Learned vocal intervals must be ordered and monophonic")
    hop = float(np.median(np.diff(times)))
    voiced = np.isfinite(f0) & (f0 > 27.5) & (f0 < 2100) & (activation >= .12) & (rms > features['rms_floor'])
    midi = np.full(len(times), np.nan)
    midi[voiced] = 69 + 12 * np.log2(f0[voiced] / 440)
    smooth = median_filter(np.where(voiced, midi, -100.), size=3, mode='nearest')
    # Keep one candidate per acoustic attack, not every high frame on its rise.
    peaks, _ = find_peaks(attack, height=.45, prominence=.2, distance=max(1, round(.055 / hop)))
    attack_times = times[peaks]
    attack_strength = attack[peaks]
    boundary_edits, unchanged = [], 0

    def pitch_starts(pitch):
        supported = voiced & (abs(smooth - pitch) <= .8)
        starts = np.flatnonzero(supported & ~np.r_[False, supported[:-1]])
        stable = [index for index in starts if supported[index:min(len(supported), index + max(3, round(.05 / hop)))].mean() >= .7]
        return np.asarray([max(0., times[index] - hop / 2) for index in stable])

    candidates_by_pitch = {pitch: pitch_starts(pitch) for pitch in {event['midi_pitch'] for event in source} if pitch is not None}
    for index in range(1, len(source)):
        before, current = source[index - 1], source[index]
        old_before, old_current = events[index - 1], events[index]
        raw = float(old_current['source_start_seconds'])
        if abs(old_before['source_end_seconds'] - raw) > .006:
            unchanged += 1
            continue
        a, b = old_before['midi_pitch'], old_current['midi_pitch']
        if a is None and b is None:
            continue
        before_duration = old_before['source_end_seconds'] - old_before['source_start_seconds']
        current_duration = old_current['source_end_seconds'] - old_current['source_start_seconds']
        minimum_left = min(.30, before_duration) if a is None and before_duration >= .18 else min(.055, before_duration * .5)
        minimum_right = min(.30, current_duration) if b is None and current_duration >= .18 else min(.055, current_duration * .5)
        lower = max(before['source_start_seconds'] + minimum_left, raw - .10)
        upper = min(current['source_end_seconds'] - minimum_right, raw + .16)
        if lower >= upper:
            continue
        candidates = []
        if b is not None and a != b:
            for at in candidates_by_pitch[b]:
                if not lower <= at <= upper:
                    continue
                window = (times >= at) & (times < min(at + .08, old_current['source_end_seconds']))
                if window.sum() < 3:
                    continue
                support = float(np.mean(voiced[window] & (abs(smooth[window] - b) <= .8)))
                preceding = (times >= at - .035) & (times < at)
                prior_support = float(np.mean(voiced[preceding] & (abs(smooth[preceding] - b) <= .8))) if preceding.any() else 0.
                contrast = support - prior_support
                if support >= .7 and contrast >= .35:
                    candidates.append((abs(at - raw) / .16 + (1 - support) * .6, float(at), 'pitched_vowel_onset'))
        elif b is None and a is not None:
            in_pitch = voiced & (abs(smooth - a) <= 1.2)
            ends = np.flatnonzero(in_pitch & ~np.r_[in_pitch[1:], False])
            for end in ends:
                at = float(times[end] + hop / 2)
                if not lower <= at <= upper:
                    continue
                after = (times > at) & (times <= at + .05)
                if after.sum() >= 3 and in_pitch[after].mean() <= .3:
                    candidates.append((abs(at - raw) / .16, at, 'pitched_release'))
        # Same-note syllables need independent attack evidence; continuity of
        # pitch alone cannot locate a consonant or decide to merge repeated words.
        if a == b and b is not None:
            for at, strength in zip(attack_times, attack_strength):
                if lower <= at <= upper:
                    candidates.append((abs(at - raw) / .16 + (1 - strength) * .2, float(at), 'same_pitch_reattack'))
        if not candidates:
            unchanged += 1
            continue
        _, at, reason = min(candidates)
        if abs(at - raw) < .008:
            unchanged += 1
            continue
        before['source_end_seconds'] = at
        current['source_start_seconds'] = at
        if 'end_seconds' in before:
            before['end_seconds'] += at - old_before['source_end_seconds']
        if 'start_seconds' in current:
            current['start_seconds'] += at - raw
        boundary_edits.append({'eventIndex': index, 'originalSeconds': raw, 'alignedSeconds': at, 'reason': reason, 'pitchBefore': a, 'pitchAfter': b})
    return source, {'version': VERSION, 'eventsPreserved': len(source) == len(events), 'pitchSequenceUnchanged': True,
                    'referenceUsed': False, 'globalDelaySeconds': 0., 'boundaryEdits': boundary_edits,
                    'unchangedBoundaries': unchanged, 'maximumShiftSeconds': max((abs(item['alignedSeconds'] - item['originalSeconds']) for item in boundary_edits), default=0.)}

"""Use a full, independently inferred monophonic lead for its identified source."""
from __future__ import annotations

import math
from pathlib import Path

from .multi_decode import source_key
from .phoneme import _load_contour, _validate_events

MONOPHONIC_LEAD = 'phoneme-fcpe-monophonic-lead-1'


def recover_voiced_islands(events: list[dict], contour_path: str | Path, *,
                          duration: float) -> tuple[list[dict], dict]:
    """Recover a stable different pitch after an unvoiced gap inside one learned note."""
    import numpy as np
    from .lead_note_proposal import runs

    minimum_gap, minimum_island, maximum_tail = .15, .10, .03
    minimum_activation, maximum_spread, minimum_pitch_change = .50, .65, 2
    _validate_events(events, duration)
    times, frequency, activation = _load_contour(Path(contour_path), duration)
    edits, output = [], []
    if len(times) < 2:
        return events, {'version': 'phoneme-voiced-islands-1', 'edits': edits, 'claimsPitchTruth': False}
    hop = float(np.median(np.diff(times)))
    voiced = np.isfinite(frequency) & (frequency > 0) & (activation >= .03)
    midi = np.full(len(times), np.nan)
    midi[voiced] = 69 + 12 * np.log2(frequency[voiced] / 440)
    for index, event in enumerate(events):
        start, end, pitch = (event[key] for key in ('source_start_seconds', 'source_end_seconds', 'midi_pitch'))
        next_start = events[index + 1]['source_start_seconds'] if index + 1 < len(events) else duration
        tail_limit = min(end + maximum_tail, next_start, duration)
        begin, stop = np.searchsorted(times, (start, tail_limit))
        spans = [(begin + left, begin + right) for left, right, is_voiced in runs(voiced[begin:stop]) if is_voiced]
        if len(spans) < 2:
            output.append(event)
            continue
        # Split the last voiced island only. Material between earlier islands
        # stays attached to the preceding learned note, including F0 dropouts.
        (before_start, before_end), (island_start, island_end) = spans[-2:]
        voiced_end = float(times[before_end - 1]) + hop
        island_left = float(times[island_start])
        island_right = min(tail_limit, float(times[island_end - 1]) + hop)
        gap = min((island_start - before_end) * hop, island_left - voiced_end)
        before_support = np.count_nonzero(np.abs(midi[before_start:before_end] - pitch) <= .65) * hop
        if (gap < minimum_gap - 1e-7 or before_support < minimum_island - 1e-7
                or island_left >= end or island_right - island_left < minimum_island - 1e-7
                or (island_end - island_start) * hop < minimum_island - 1e-7
                or np.any(np.diff(times[island_start:island_end]) > hop * 1.5)):
            output.append(event)
            continue
        island_pitches = midi[island_start:island_end]
        island_median = float(np.median(island_pitches))
        island_pitch = round(island_median)
        strength = float(np.median(activation[island_start:island_end]))
        spread = float(np.quantile(island_pitches, .9) - np.quantile(island_pitches, .1))
        if (strength < minimum_activation or spread > maximum_spread
                or not 1 <= island_pitch <= 127 or abs(island_median - island_pitch) > .35
                or abs(island_pitch - pitch) < minimum_pitch_change):
            output.append(event)
            continue
        head_end = round(voiced_end + maximum_tail, 6)
        island_left, island_right = round(island_left, 6), round(island_right, 6)
        head = dict(event, source_end_seconds=head_end, end_seconds=head_end)
        tail = dict(event, source_start_seconds=island_left, start_seconds=island_left,
                    source_end_seconds=island_right, end_seconds=island_right, midi_pitch=island_pitch)
        output.extend((head, tail))
        edits.append({'sourceEvent': event, 'resultEvents': [head, tail], 'unvoicedGapSeconds': round(gap, 6),
                      'islandMedianMidi': round(island_median, 4), 'islandPitchSpreadSemitones': round(spread, 4),
                      'islandMedianActivation': round(strength, 4)})
    _validate_events(output, duration)
    return output, {'version': 'phoneme-voiced-islands-1', 'edits': edits, 'claimsPitchTruth': False,
                    'minimumUnvoicedGapSeconds': minimum_gap, 'minimumIslandSeconds': minimum_island,
                    'maximumTailSeconds': maximum_tail, 'minimumIslandMedianActivation': minimum_activation,
                    'maximumIslandPitchSpreadSemitones': maximum_spread,
                    'minimumPitchChangeSemitones': minimum_pitch_change}


def _covers_waveform(run: dict, duration: float) -> bool:
    reported = run.get('duration_seconds')
    chunks = run.get('chunks')
    if (not isinstance(reported, (int, float)) or not math.isfinite(reported)
            or abs(reported - duration) > 1e-6 or not isinstance(chunks, list) or not chunks):
        return False
    cursor, sample_rate = 0, chunks[0].get('sample_rate') if isinstance(chunks[0], dict) else None
    if type(sample_rate) is not int or sample_rate <= 0:
        return False
    for chunk in chunks:
        if not isinstance(chunk, dict):
            return False
        left, right, frames = (chunk.get(field) for field in ('core_left', 'core_right', 'frames'))
        if (any(type(value) is not int for value in (left, right, frames))
                or chunk.get('sample_rate') != sample_rate or left != cursor or right <= left or frames <= 0):
            return False
        cursor = right
    # The resampler may ceil the final core by less than one sample.
    return abs(cursor - duration * sample_rate) <= 1 + 1e-6


def replace_vocal_lead(events: list[dict], learned_result: dict | None, *,
                       source_id: str, source_label: str, duration: float,
                       voice_verification: dict | None) -> tuple[list[dict], dict]:
    """Replace one source's program 100 events after a same-waveform full run.

    The caller owns the identity of the waveform, its FCPE contour, and the
    verification samples. The sampled verifier can veto replacement. Passing
    it does not establish the correctness of pitches outside those samples.
    """
    audit = {'version': MONOPHONIC_LEAD, 'sourceId': source_id, 'status': 'unavailable',
             'replacedNativeLeadEvents': 0, 'learnedLeadEvents': 0, 'fullWaveformCoverage': False,
             'claimsWholeSongPitchTruth': False}
    if learned_result is None:
        return events, audit
    if learned_result.get('success') is not True:
        return events, {**audit, 'status': 'failed'}
    if (not isinstance(duration, (float, int)) or not math.isfinite(duration)
            or duration <= 0 or not _covers_waveform(learned_result, duration)):
        return events, {**audit, 'status': 'incomplete_coverage'}
    audit.update(fullWaveformCoverage=True, durationSeconds=duration,
                 chunks=len(learned_result['chunks']))
    if isinstance(learned_result.get('artifact_path'), str):
        audit['learnedArtifact'] = learned_result['artifact_path']
    try:
        lead = _validate_events(learned_result.get('events'), duration)
    except ValueError:
        return events, {**audit, 'status': 'invalid_lead_events'}
    if any(a['source_end_seconds'] > b['source_start_seconds'] + 1e-7 for a, b in zip(lead, lead[1:])):
        return events, {**audit, 'status': 'invalid_lead_events'}
    if not lead:
        return events, {**audit, 'status': 'empty'}
    audit['learnedLeadEvents'] = len(lead)
    verification = voice_verification or {}
    if (verification.get('available') is not True or verification.get('abstain') is not False
            or not verification.get('intervals')):
        return events, {**audit, 'status': 'unverified'}
    audit['pitchVerification'] = 'non-abstaining samples only'
    identity = source_key({'sourceId': source_id})
    if identity is None:
        return events, {**audit, 'status': 'no_native_lead_for_source'}
    retained = [event for event in events if not (event['program'] == 100
                and event['isDrum'] is False and source_key(event) == identity)]
    replaced = len(events) - len(retained)
    if not replaced:
        return events, {**audit, 'status': 'no_native_lead_for_source'}
    for index, note in enumerate(lead):
        notation_end = note.get('notation_end_seconds', note['source_end_seconds'])
        limit = lead[index + 1]['source_start_seconds'] if index + 1 < len(lead) else duration
        if (type(notation_end) not in (float, int) or not math.isfinite(notation_end)
                or not note['source_end_seconds'] <= notation_end <= limit):
            return events, {**audit, 'status': 'invalid_notation_boundary'}
    replacement = [
        {'start': note['source_start_seconds'], 'end': min(note.get('notation_end_seconds', note['source_end_seconds']), duration),
         'acousticEnd': note['source_end_seconds'],
         'midi': note['midi_pitch'], 'program': 100, 'isDrum': False, 'velocity': .75,
         'sourceId': identity, 'sourceLabel': source_label, 'evidenceOrigins': ['phoneme_fcpe'],
         'rhythmEvidence': MONOPHONIC_LEAD}
        for note in lead
    ]
    return sorted(retained + replacement, key=lambda e: (e['start'], e['program'], e['midi'])), {
        **audit, 'status': 'replaced', 'replacedNativeLeadEvents': replaced,
    }


def _native_pitch_disputes(learned, native, *, octave_overlaps=False):
    for candidate in native:
        start, end, midi = (candidate.get(key) for key in ('start', 'end', 'midi'))
        if (type(midi) is not int or not 1 <= midi <= 127
                or any(type(x) not in (int, float) or not math.isfinite(x) for x in (start, end))
                or not 0 <= start < end):
            continue
        overlaps = [(min(end, event['source_end_seconds']) - max(start, event['source_start_seconds']), index)
                    for index, event in enumerate(learned)]
        if octave_overlaps:
            for overlap, index in overlaps:
                event = learned[index]
                left = max(start, event['source_start_seconds'])
                right = min(end, event['source_end_seconds'])
                shorter = min(end - start, event['source_end_seconds'] - event['source_start_seconds'])
                if abs(event['midi_pitch'] - midi) == 12 and overlap >= .07 and overlap >= .5 * shorter:
                    yield index, candidate, left, right, overlap
            continue
        significant = [(overlap, index) for overlap, index in overlaps
                       if overlap >= min(.065, (end - start) * .5)]
        if not significant or any(learned[index]['midi_pitch'] == midi for _, index in significant):
            continue
        overlap, index = max(significant)
        event = learned[index]
        left = max(event['source_start_seconds'], start - .04)
        right = min(event['source_end_seconds'], end + .06)
        yield index, candidate, left, right, overlap


def _contour_slice(times, left, right):
    import numpy as np

    lo, hi = np.searchsorted(times, (left, right))
    sample_times = times[lo:hi]
    if (len(sample_times) < 2 or sample_times[0] - left > .025 or right - sample_times[-1] > .025
            or np.any(np.diff(sample_times) > .031)):
        return None
    return slice(lo, hi)


def _pitch_plateau(times, pitches, quality, left, right, target, minimum_seconds, *, maximum_spread=.75):
    import numpy as np
    from .lead_note_proposal import runs

    selection = _contour_slice(times, left, right)
    if selection is None:
        return None, False
    lo, hi = selection.start, selection.stop
    sample_times = times[selection]
    hop = float(np.median(np.diff(sample_times)))
    near_target = quality[lo:hi] & np.all(np.abs(pitches[:, lo:hi] - target) <= .5, axis=0)
    plateaus = []
    for start, end, supported in runs(near_target):
        if not supported:
            continue
        onset, offset = float(sample_times[start]), min(right, float(sample_times[end - 1]) + hop)
        if offset - onset < minimum_seconds - 1e-7:
            continue
        region = pitches[:, lo + start:lo + end]
        spread = np.quantile(region, .9, axis=1) - np.quantile(region, .1, axis=1)
        if np.any(spread > maximum_spread):
            continue
        plateaus.append((onset, offset, end - start))
    return max(plateaus, key=lambda value: value[1] - value[0], default=None), True


def _midi_contour(hz):
    import numpy as np

    return 69 + 12 * np.log2(np.where(hz > 0, hz, np.nan) / 440)


def vocal_consensus_windows(learned, native, fcpe_times, fcpe_hz, fcpe_activation, duration: float):
    """Prioritize exact octaves and real FCPE-backed competing pitch regions."""
    import numpy as np

    times, frequency, activation = map(np.asarray, (fcpe_times, fcpe_hz, fcpe_activation))
    pitches = _midi_contour(frequency)[None, :]
    windows = []
    for index, note, left, right, overlap in _native_pitch_disputes(learned, native):
        distance = abs(note['midi'] - learned[index]['midi_pitch'])
        plateau, _ = _pitch_plateau(times, pitches, activation >= .5, left, right, note['midi'],
                                    .12 if distance == 1 else .10)
        if (distance == 12 and overlap >= .07) or plateau:
            windows.append((distance != 12, -(right - left), max(0., left - .5), min(duration, right + .5)))
    selected = []
    for _, _, left, right in sorted(windows):
        merged = []
        for start, end in sorted([*selected, (left, right)]):
            if merged and start <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
            else:
                merged.append((start, end))
        if sum(end - start for start, end in merged) <= 60.:
            selected = merged
    return selected


def adjudicate_vocal_consensus(learned, native, contour) -> tuple[list[dict], dict]:
    """Replace portions of a learned event only where two acoustic F0s agree.

    A mixed-audio event may propose a competing pitch. Its raw timestamps are
    a search window, and the jointly voiced plateau supplies the new times.
    Same-pitch reattacks and absent or incomplete CREPE coverage stay unchanged.
    """
    import numpy as np

    audit = {'version': 'multi-vocal-consensus-3', 'edits': [], 'abstentions': [], 'octaveDisagreements': [],
             'claimsPitchTruth': False, 'unmeasuredDisputes': 0, 'unmeasuredOctaveDisputes': 0}
    if contour is None:
        audit['status'] = 'unavailable'
        return learned, audit
    keys = ('time', 'crepeF0', 'periodicity', 'fcpeF0', 'fcpeActivation')
    times, crepe, periodicity, fcpe, activation = [np.asarray(contour[key], dtype=float) for key in keys]
    if (times.ndim != 1 or any(a.shape != times.shape for a in (crepe, periodicity, fcpe, activation))
            or not np.all(np.isfinite(times)) or np.any(np.diff(times) <= 0)):
        raise ValueError('Invalid local vocal consensus contour')
    pitches = np.vstack((_midi_contour(crepe), _midi_contour(fcpe)))
    quality = (periodicity >= .60) & (activation >= .50)
    jointly_unvoiced = (periodicity < .30) & (activation < .03)
    accepted = {}
    for index, note, left, right, _ in _native_pitch_disputes(learned, native, octave_overlaps=True):
        event = learned[index]
        plateau, measured = _pitch_plateau(times, pitches, quality, left, right, note['midi'], .10)
        # Two F0 estimators on one source can share an octave error. Keep
        # secondary overlaps visible as well, without rewriting an octave.
        audit['octaveDisagreements'].append({'sourceEvent': event, 'nativeEvent': note,
                                            'overlapStartSeconds': left, 'overlapEndSeconds': right,
                                            'jointAlternativePlateau': plateau,
                                            'measured': measured, 'applied': False})
        audit['unmeasuredOctaveDisputes'] += int(not measured)
    for index, note, left, right, _ in _native_pitch_disputes(learned, native):
        event = learned[index]
        distance = abs(note['midi'] - event['midi_pitch'])
        if distance == 12:
            continue
        plateau, measured = _pitch_plateau(times, pitches, quality, left, right, note['midi'],
                                            .14 if distance == 1 else .10, maximum_spread=.35)
        audit['unmeasuredDisputes'] += int(not measured)
        if plateau:
            start, end, _ = plateau
            if min(end, note['end']) - max(start, note['start']) >= .5 * (end - start) - 1e-7:
                accepted.setdefault(index, []).append((plateau, note))
    output = []
    for index, event in enumerate(learned):
        candidates = accepted.get(index, [])
        chosen = []
        for plateau, note in sorted(candidates, key=lambda c: (-(c[0][1] - c[0][0]), c[0][0])):
            a, b, _ = plateau
            if not any(min(b, other[1]) > max(a, other[0]) for other, _ in chosen):
                chosen.append((plateau, note))
        if not chosen:
            output.append(event)
            continue
        start, end, original_pitch = (event[key] for key in ('source_start_seconds', 'source_end_seconds', 'midi_pitch'))
        if _contour_slice(times, start, end) is None:
            output.append(event)
            audit['abstentions'].append({'sourceEvent': event, 'reason': 'incomplete_learned_event_coverage'})
            continue
        resulting = []
        position = start

        def keep(start, end, midi):
            a, b = round(start, 6), round(end, 6)
            if resulting and resulting[-1]['midi_pitch'] == midi and a - resulting[-1]['source_end_seconds'] < .09:
                resulting[-1].update(source_end_seconds=b, end_seconds=b)
                return
            resulting.append(dict(event, source_start_seconds=a, start_seconds=a,
                                  source_end_seconds=b, end_seconds=b, midi_pitch=midi))

        def retain_supported_residual(left, right):
            if right - left < .09 - 1e-7:
                return True  # Brief pitch transitions are not a separate syllable.
            selection = _contour_slice(times, left, right)
            if selection is None:
                return False
            support = quality[selection] & np.all(np.abs(pitches[:, selection] - original_pitch) <= .5, axis=0)
            if np.mean(support) >= .50:
                plateau, _ = _pitch_plateau(times, pitches, quality, left, right, original_pitch, .09)
                if plateau:
                    keep(left, right, original_pitch)
                    return True
            return np.mean(jointly_unvoiced[selection]) >= .80

        residuals_supported = True
        for (left, right, _), note in sorted(chosen, key=lambda c: c[0][0]):
            if not retain_supported_residual(position, left):
                residuals_supported = False
                break
            keep(left, right, note['midi'])
            position = right
        if not residuals_supported or not retain_supported_residual(position, end):
            output.append(event)
            audit['abstentions'].append({'sourceEvent': event, 'reason': 'voiced_residual_without_supported_pitch'})
            continue
        trajectory = [note['midi_pitch'] for note in resulting]
        if any(a == c and abs(a - b) == 1 for a, b, c in zip(trajectory, trajectory[1:], trajectory[2:])):
            output.append(event)
            audit['abstentions'].append({'sourceEvent': event, 'reason': 'semitone_neighbor_return'})
            continue
        context = ([output[-1]] if output else []) + resulting + learned[index+1:index+2]
        neighbor_return = any(
            left['midi_pitch']==right['midi_pitch'] and 0<abs(left['midi_pitch']-middle['midi_pitch'])<=2
            and middle['source_end_seconds']-middle['source_start_seconds']<=.22
            and middle['source_start_seconds']-left['source_end_seconds']<=.09
            and right['source_start_seconds']-middle['source_end_seconds']<=.09
            and any(middle is proposed for proposed in resulting)
            for left,middle,right in zip(context,context[1:],context[2:]))
        if neighbor_return:
            output.append(event)
            audit['abstentions'].append({'sourceEvent':event,'reason':'cross_boundary_neighbor_return'})
            continue
        output.extend(resulting)
        audit['edits'].append({'sourceEvent': event, 'resultEvents': resulting,
                               'jointPitchPlateaus': [{'nativeEvent': note, 'startSeconds': a,
                                                       'endSeconds': b, 'frames': frames}
                                                      for (a, b, frames), note in sorted(chosen)]})
    audit['status'] = 'adjudicated'
    return output, audit

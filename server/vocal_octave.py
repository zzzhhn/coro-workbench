"""Adjudicate disputed vocal octaves with source and harmonic evidence."""
from __future__ import annotations

from pathlib import Path

import numpy as np

VERSION = 'vocal-octave-comb-2'
_WINDOW_SECONDS = .08
_HOP_SECONDS = .02
_TUNING = np.linspace(-.65, .65, 27)
_ATTACK_TUNING = np.linspace(-2.5, 2.5, 101)
_EVEN = np.array([1, 3, 5, 7])
_HIGHER_ODD = np.array([2, 4, 6])


def _comb(vocal, residual, bins, nominal_hz, tuning):
    def db(amplitude, reference):
        return 20 * np.log10(np.maximum(amplitude, 1e-9) / np.maximum(reference, 1e-9))

    hz = (nominal_hz * 2 ** (tuning[:, None] / 12)) * np.arange(1, 9)
    grid = np.interp(hz, bins, vocal)
    # Fit one tuning across the octave's harmonics. The square root keeps a
    # single loud spectral line from winning over a multi-partial comb.
    best = int(np.argmax(np.sqrt(grid[:, _EVEN]).sum(axis=1)))
    tuned = hz[best]
    measured = grid[best]
    floor = np.interp(tuned, bins, residual)
    offset = min(nominal_hz * .22, 47.)
    shoulder = np.maximum(np.interp(tuned - offset, bins, vocal), np.interp(tuned + offset, bins, vocal))
    upper_peak = measured[_EVEN].max()
    relative = db(measured, upper_peak)
    ownership = db(measured, floor)
    upper_lines = ((relative[_EVEN] >= -22.) & (ownership[_EVEN] >= 6.)
                   & (db(measured[_EVEN], shoulder[_EVEN]) >= 7.))
    # Require an odd harmonic of the *upper* candidate. For example, 4f and
    # 8f alone also fit 4f as a fundamental and do not establish 2f.
    upper_supported = np.count_nonzero(upper_lines) >= 2 and np.any(upper_lines[[0, 2]])
    odd_relative = relative[_HIGHER_ODD].max()
    low_relative = relative[0]
    low_safe = low_relative <= -10. or (low_relative <= -6. and ownership[0] <= -3.)
    low_supported = odd_relative > -16. or not low_safe
    return (float(max(upper_peak, measured[0], measured[_HIGHER_ODD].max())), bool(upper_supported),
            float(odd_relative), float(low_relative), float(ownership[0]), bool(low_supported),
            float(tuning[best]), np.count_nonzero(upper_lines), float(upper_peak))


def _spectral_frames(vocal, mixture, centers, low_hz, window_seconds, tuning):
    rate = vocal.samplerate
    length = round(rate * window_seconds)
    transform = 1 << (4 * length - 1).bit_length()
    bins = np.fft.rfftfreq(transform, d=1 / rate)
    window = np.hanning(length)[:, None] * (2 / length)
    rows = []
    for center in centers:
        position = round(center * rate) - length // 2
        if position < 0 or position + length > min(vocal.frames, mixture.frames):
            return None
        vocal.seek(position)
        mixture.seek(position)
        voice = vocal.read(length, always_2d=True, dtype='float32')
        original = mixture.read(length, always_2d=True, dtype='float32')
        spectra = []
        # Subtract waveforms before measuring amplitudes to preserve phase.
        for signal in (voice, original - voice):
            fft = np.fft.rfft(signal * window, n=transform, axis=0)
            spectra.append(np.sqrt(np.mean(abs(fft)**2, axis=1)))
        rows.append(_comb(*spectra, bins, low_hz, tuning))
    return np.asarray(rows).T


def _moving_attack(vocal, mixture, start, end, low_hz):
    """Recognize an upper pitch that bends into the disputed note's target."""
    if not .23 <= end - start <= .50:
        return None
    if 8 * low_hz * 2 ** (_ATTACK_TUNING[-1] / 12) + 47 >= vocal.samplerate / 2:
        return None
    left, right = start + .03, end - .03
    count = 1 + int((right - left) / .015 + 1e-6)
    centers = np.linspace(left, right, count)
    rows = _spectral_frames(vocal, mixture, centers, low_hz, .06, _ATTACK_TUNING)
    if rows is None:
        return None
    _, upper, odd, low, owner, _, tuning, lines, strength = rows
    upper = upper.astype(bool)
    active = strength >= max(.0001, .22 * np.quantile(strength, .8))
    head = np.flatnonzero(active & upper & (abs(tuning) >= 1.) & (centers <= (start + end) / 2))
    if head.size < 3:
        return None  # The stationary comb can adjudicate without a bent attack.
    result = {'decision': 'ambiguous', 'method': 'upper_attack_ridge',
              'attackStartSemitones': round(float(np.median(tuning[head])), 3)}
    target = active & (abs(tuning) <= .5)
    for first in range(head[-1] + 1, count - 4):
        landing = slice(first, first + 5)
        if np.all(target[landing]) and np.count_nonzero(upper[landing]) >= 3 and np.all(lines[landing] >= 1):
            break
    else:
        return result
    ridge = slice(head[0], first + 5)
    # The bend must connect the earlier owned harmonics to the landing. A
    # separate higher tail after an interruption is not the same sung note.
    if (not np.all(active[ridge]) or np.max(abs(np.diff(tuning[ridge]))) > .95
            or np.mean(upper[ridge]) < .65):
        return result
    # A genuinely lower voice can have strong even harmonics. Follow its
    # odd lines and half-frequency component along the *same* moving ridge.
    strong_low = (odd[ridge] > -16.) | ((low[ridge] > -6.) & (owner[ridge] > -3.))
    if (np.mean(strong_low) > .15 or np.median(odd[ridge]) > -20.
            or np.median(low[ridge]) > -10.):
        return result
    return {**result, 'decision': 'upper_octave',
            'attackRidgeStartSeconds': round(float(centers[head[0]]), 6),
            'targetLandingSeconds': round(float(centers[first]), 6),
            'attackRidgeFrames': first + 5 - int(head[0])}


def _anchored_sustain(vocal, mixture, start, low_hz, rows):
    """Keep a continuous upper tone when the low line swells after its onset."""
    anchor_centers = start + np.arange(-6, 4) * _HOP_SECONDS
    anchor = _spectral_frames(vocal, mixture, anchor_centers, low_hz, _WINDOW_SECONDS, _TUNING)
    if anchor is None:
        return None
    _, upper, odd, low, _, _, tuning, _, peak = anchor
    if (not np.all(upper.astype(bool) & (odd <= -18.) & (low <= -10.))
            or np.max(abs(np.diff(tuning))) > .65 or np.min(peak) < .32 * np.max(peak)):
        return None
    strength, upper, odd, low, owner, _, _, _, _ = rows
    active = strength >= max(.0001, .22 * np.quantile(strength, .8))
    # Keep coverage through the voiced body. The sustained portion can
    # contain a low component, but it cannot take over the dominant line.
    if not np.any(active) or np.mean(upper[active]) < .85:
        return None
    if np.median(odd[active]) > -20. or np.median(low[active]) > -8.:
        return None
    dominant_low = active & ((odd > -16.) | ((low >= 0.) & (owner > -3.)))
    if np.any(np.convolve(dominant_low, np.ones(4), mode='valid') >= 4):
        return None
    return {'decision': 'upper_octave', 'method': 'anchored_upper_sustain',
            'upperAnchorStartSeconds': round(float(anchor_centers[0]), 6),
            'upperAnchorEndSeconds': round(float(anchor_centers[-1]), 6),
            'upperAnchorFrames': len(anchor_centers)}


def _measure(vocal, mixture, start, end, midi):
    low_hz = 440 * 2 ** ((midi - 69) / 12)
    if low_hz < 65 or 8 * low_hz * 2 ** (_TUNING[-1] / 12) + 47 >= vocal.samplerate / 2:
        return {'decision': 'outside_analysis_band'}
    # Sample a long event at evenly distributed points; never read a full
    # song or a very long event into memory for this optional check.
    left = start + _WINDOW_SECONDS / 2
    right = end - _WINDOW_SECONDS / 2
    if right <= left:
        return {'decision': 'insufficient_coverage'}
    count = min(192, 1 + int((right - left) / _HOP_SECONDS + 1e-6))
    if count < 5:
        return {'decision': 'insufficient_coverage'}
    centers = np.linspace(left, right, count)
    rows = _spectral_frames(vocal, mixture, centers, low_hz, _WINDOW_SECONDS, _TUNING)
    if rows is None:
        return {'decision': 'insufficient_coverage'}
    strength, upper, odd, low, owner, low_supported, *_ = rows
    active = strength >= max(.0001, .22 * np.quantile(strength, .8))
    supports = active & upper.astype(bool) & (odd <= -18.) & ~low_supported.astype(bool)
    vetoes = active & low_supported.astype(bool)
    active_count = int(np.count_nonzero(active))
    supported_count = int(np.count_nonzero(supports))
    veto_count = int(np.count_nonzero(vetoes))
    result = {'decision': 'ambiguous', 'frames': count, 'activeFrames': active_count,
              'upperCombFrames': int(np.count_nonzero(active & upper.astype(bool))),
              'upperEvidenceFrames': supported_count, 'lowEvidenceFrames': veto_count}
    if not active_count:
        return result
    result.update(higherOddMedianRelativeDb=round(float(np.median(odd[active])), 2),
                  lowFundamentalMedianRelativeDb=round(float(np.median(low[active])), 2),
                  lowFundamentalMedianVocalToResidualDb=round(float(np.median(owner[active])), 2))
    # Do not change the written pitch based on a brief high tail or alter
    # timings. Low energy before an onset does not count against voiced frames.
    if (supported_count / count >= .35 and supported_count / active_count >= .70
            and veto_count / active_count <= .20 and supported_count * (right - left) / (count - 1) >= .10):
        result['decision'] = 'upper_octave'
    attack = _moving_attack(vocal, mixture, start, end, low_hz)
    if attack is not None:
        return {**result, **attack}
    if result['decision'] == 'ambiguous' and .50 < end - start <= 192 * _HOP_SECONDS:
        sustain = _anchored_sustain(vocal, mixture, start, low_hz, rows)
        if sustain is not None:
            return {**result, **sustain}
    return result


def adjudicate_vocal_octaves(events: list[dict], native: list[dict], *,
                            vocal_path: str | Path, mixture_path: str | Path) -> tuple[list[dict], dict]:
    """Promote a whole lead event only for a corroborated, octave-up proposal.

    The two waveforms must be aligned, gain-matched and on the same sample
    grid. The native lead only proposes candidates; its pitch never bypasses
    acoustic checks. A sustained competing low component can veto promotion
    even if the upper series is present. The output retains raw F0, event
    timing, event count, and unresolved alternatives.
    """
    import soundfile as sf

    from .multi_vocal import _native_pitch_disputes

    audit = {'version': VERSION, 'status': 'adjudicated', 'edits': [], 'candidates': [],
             'claimsPitchTruth': False}
    proposals = {}
    for index, note, left, right, overlap in _native_pitch_disputes(events, native, octave_overlaps=True):
        current = proposals.get(index)
        if not current or overlap > current[-1]:
            proposals[index] = (note, left, right, overlap)
    if not proposals:
        return events, audit
    output = events.copy()
    with sf.SoundFile(vocal_path) as vocal, sf.SoundFile(mixture_path) as mixture:
        if ((vocal.samplerate, vocal.channels) != (mixture.samplerate, mixture.channels)
                or abs(vocal.frames - mixture.frames) > 1):
            audit['status'] = 'waveforms_not_on_same_sample_grid'
            return events, audit
        for index, (note, left, right, _) in sorted(proposals.items()):
            event = events[index]
            details = {'sourceEvent': event, 'nativeEvent': note, 'overlapStartSeconds': left,
                       'overlapEndSeconds': right}
            if note['midi'] < event['midi_pitch']:
                details['decision'] = 'downward_proposal_not_adjudicated'
            else:
                details.update(_measure(vocal, mixture, event['source_start_seconds'],
                                        event['source_end_seconds'], event['midi_pitch']))
            audit['candidates'].append(details)
            if details['decision'] == 'upper_octave':
                output[index] = dict(event, midi_pitch=note['midi'])
                audit['edits'].append({**details, 'resultEvent': output[index]})
    return output, audit

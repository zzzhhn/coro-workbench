"""Audit-first check of long low piano notes for a missing lower octave.

Recognition layer. YourMT3+ may report a deep piano bass one octave high
(G2 for a played G1). For every long low piano event this module measures four
evidence paths for the octave below, records them as candidates, and changes
the default score only when at least MIN_AGREEING paths support the lower
octave. Onset and duration are never changed; the original pitch stays in the
audit. No reference score is read.

Paths (independent views of the same moment):
  stem_model:   ByteDance frame activation, separated piano stem
  mix_model:    ByteDance frame activation, original mixture
  bass_stem:    fundamental dominates its 2nd harmonic in the bass stem
  piano_stem:   fundamental is not weaker than its 2nd harmonic in the piano stem
"""
from __future__ import annotations

import numpy as np

VERSION = 'piano-low-octave-audit-1'
MIN_AGREEING = 2
LOW_PITCH = 55          # below G3: the register where octave confusions occur
MIN_SECONDS = .6        # long notes only; short runs are out of scope
WINDOW = (.03, 1.0)     # seconds after onset used for evidence
FRAME_SUPPORT = .5      # ByteDance frame probability (model's own decision level)
BASS_RATIO = 2.         # f0 band energy / 2*f0 band energy in the bass stem
PIANO_RATIO = 1.        # piano stem: lower fundamental at least as strong as its octave


def _band(spec, freqs, hz):
    lo, hi = hz * 2 ** (-.5 / 12), hz * 2 ** (.5 / 12)
    return float(spec[(freqs > lo) & (freqs < hi)].sum())


def _spectrum(audio, sr, start, end):
    segment = audio[int(start * sr):int(end * sr)]
    if len(segment) < 2048:
        return None, None
    spec = np.abs(np.fft.rfft(segment * np.hanning(len(segment))))
    return spec, np.fft.rfftfreq(len(segment), 1 / sr)


def evidence(event, stem_frames, mix_frames, bass, piano, sr, fps=100):
    lower = event['midi'] - 12
    if lower < 21:
        return None
    t0 = event['start'] + WINDOW[0]
    t1 = event['start'] + min(WINDOW[1], event['end'] - event['start'])
    f0, f1 = int(t0 * fps), max(int(t0 * fps) + 1, int(t1 * fps))
    key = lower - 21
    paths = {}
    for name, frames in (('stem_model', stem_frames), ('mix_model', mix_frames)):
        if frames is not None and f1 <= len(frames):
            paths[name] = float(frames[f0:f1, key].mean())
    hz = 440 * 2 ** ((lower - 69) / 12)
    for name, audio in (('bass_stem', bass), ('piano_stem', piano)):
        if audio is None:
            continue
        spec, freqs = _spectrum(audio, sr, t0, t1)
        if spec is not None:
            paths[name] = _band(spec, freqs, hz) / (_band(spec, freqs, 2 * hz) + 1e-9)
    support = {
        'stem_model': paths.get('stem_model', 0) >= FRAME_SUPPORT,
        'mix_model': paths.get('mix_model', 0) >= FRAME_SUPPORT,
        'bass_stem': paths.get('bass_stem', 0) >= BASS_RATIO,
        'piano_stem': paths.get('piano_stem', 0) >= PIANO_RATIO,
    }
    return {'lowerMidi': lower, 'measures': {k: round(v, 4) for k, v in paths.items()},
            'supports': support, 'agreeing': sum(support.values())}


# Development review (Kong Er, 2026-11-09) found the two-path rule unreliable:
# of four promotions, two contradicted the reference. Default runs therefore
# record candidates only; promotion needs an explicit opt-in.
APPLY_BY_DEFAULT = False


def audit_low_octaves(events, stem_frames, mix_frames, bass, piano, sr, *, apply=APPLY_BY_DEFAULT):
    """Return (events, audit). Only piano events are examined."""
    result = [dict(e) for e in events]
    candidates, applied = [], 0
    for event in result:
        if (event.get('isDrum') or event.get('program') not in (0, 2) or event['midi'] >= LOW_PITCH
                or event['end'] - event['start'] < MIN_SECONDS):
            continue
        found = evidence(event, stem_frames, mix_frames, bass, piano, sr)
        if found is None:
            continue
        # The lower pitch must not already be sounding as its own piano note.
        duplicate = any(o is not event and o.get('program') in (0, 2) and o['midi'] == found['lowerMidi']
                        and abs(o['start'] - event['start']) <= .08 for o in result)
        promote = apply and found['agreeing'] >= MIN_AGREEING and not duplicate
        record = {'start': event['start'], 'end': event['end'], 'midi': event['midi'], **found,
                  'duplicateLower': duplicate, 'applied': promote}
        candidates.append(record)
        if promote:
            event['octaveCorrectedFrom'] = event['midi']
            event['midi'] = found['lowerMidi']
            applied += 1
    return result, {'version': VERSION, 'minimumAgreeingPaths': MIN_AGREEING,
                    'examined': len(candidates), 'applied': applied,
                    'candidates': candidates, 'claimsPitchTruth': False}

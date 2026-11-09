import numpy as np

from server.piano_low_octave import audit_low_octaves, MIN_AGREEING


def _tone(hz, seconds=2., sr=8000):
    t = np.arange(int(seconds * sr)) / sr
    return np.sin(2 * np.pi * hz * t)


def _frames(n, key=None):
    frames = np.zeros((n, 88), dtype=np.float32)
    if key is not None:
        frames[:, key] = .9
    return frames


def test_low_octave_is_audited_but_not_applied_by_default():
    sr = 8000
    event = {'start': .1, 'end': 1.9, 'midi': 43, 'program': 0, 'isDrum': False}  # written G2
    bass = _tone(49., sr=sr)          # real G1 fundamental in the bass stem
    piano = _tone(49., sr=sr) + .3 * _tone(98., sr=sr)
    stem, mix = _frames(200, 31 - 21), _frames(200, 31 - 21)
    events, audit = audit_low_octaves([event], stem, mix, bass, piano, sr)
    assert events[0]['midi'] == 43    # default score unchanged
    record = audit['candidates'][0]
    assert record['lowerMidi'] == 31 and record['agreeing'] >= MIN_AGREEING and not record['applied']
    assert audit['claimsPitchTruth'] is False


def test_opt_in_promotion_keeps_timing_and_needs_two_paths():
    sr = 8000
    event = {'start': .1, 'end': 1.9, 'midi': 43, 'program': 0, 'isDrum': False}
    bass = _tone(49., sr=sr)
    piano = _tone(98., sr=sr)          # piano stem shows only G2
    events, audit = audit_low_octaves([event], _frames(200), _frames(200), bass, piano, sr, apply=True)
    assert events[0]['midi'] == 43 and audit['applied'] == 0      # one path only
    events, audit = audit_low_octaves([event], _frames(200, 10), _frames(200), bass, piano, sr, apply=True)
    assert events[0]['midi'] == 31 and events[0]['octaveCorrectedFrom'] == 43
    assert (events[0]['start'], events[0]['end']) == (.1, 1.9)


def test_existing_lower_note_and_short_or_high_notes_are_left_alone():
    sr = 8000
    bass = _tone(49., sr=sr)
    events = [{'start': .1, 'end': 1.9, 'midi': 43, 'program': 0, 'isDrum': False},
              {'start': .1, 'end': 1.9, 'midi': 31, 'program': 0, 'isDrum': False},
              {'start': .1, 'end': .3, 'midi': 40, 'program': 0, 'isDrum': False},
              {'start': .1, 'end': 1.9, 'midi': 62, 'program': 0, 'isDrum': False}]
    out, audit = audit_low_octaves(events, _frames(200, 10), _frames(200, 10), bass, bass, sr, apply=True)
    assert [e['midi'] for e in out] == [43, 31, 40, 62]
    assert all(c['duplicateLower'] for c in audit['candidates'] if c['midi'] == 43)

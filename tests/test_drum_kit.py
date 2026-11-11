import numpy as np
import soundfile as sf

from server.drum_kit import MIN_ONSETS, gate_drum_events, kit_onsets

SR = 22050


def drum(start, midi=36):
    return dict(start=start, end=start + .01, midi=midi, program=128, isDrum=True)


def pitched(start):
    return dict(start=start, end=start + .5, midi=60, program=0, isDrum=False)


def render(kind, hits, seconds=20.):
    rng = np.random.default_rng(7)
    y = np.zeros(int(seconds * SR), dtype=np.float32)
    t = np.arange(int(.12 * SR)) / SR
    for start in hits:
        if kind == 'hat':
            sound = .3 * rng.normal(0, 1, len(t)) * np.exp(-t * 60)
            sound -= np.roll(sound, 1)
        else:  # low impact only, e.g. a sub-bass thump leaking into the drum stem
            sound = .6 * np.sin(2 * np.pi * 48 * t) * np.exp(-t * 25)
        a = int(start * SR)
        y[a:a + len(t)] += sound[:len(y) - a]
    return y


def write(tmp_path, drums, other):
    sf.write(tmp_path / 'stem-drums.wav', drums, SR)
    sf.write(tmp_path / 'analysis.wav', drums + other, SR)
    return tmp_path / 'stem-drums.wav', tmp_path / 'analysis.wav'


def test_broadband_kit_keeps_every_native_drum_event(tmp_path):
    hits = [.5 + i * .25 for i in range(64)]
    paths = write(tmp_path, render('hat', hits), .05 * np.sin(np.arange(int(20 * SR)) * 2 * np.pi * 220 / SR))
    events = [drum(h) for h in hits[:5]] + [pitched(1.)]
    kept, audit = gate_drum_events(events, *paths)
    assert kept == events
    assert audit['decision'] == 'keep' and audit['kitOnsets'] >= MIN_ONSETS


def test_low_impacts_without_kit_transients_are_withheld_not_deleted(tmp_path):
    hits = [.5 + i * .25 for i in range(64)]
    # A real mixture always carries broadband content (voice, room, piano).
    floor = .02 * np.random.default_rng(3).normal(0, 1, int(20 * SR)).astype(np.float32)
    paths = write(tmp_path, render('thump', hits), floor)
    events = [drum(h) for h in hits[:5]] + [pitched(1.)]
    kept, audit = gate_drum_events(events, *paths)
    assert kept == [pitched(1.)]
    assert audit['decision'] == 'withhold' and audit['withheldEvents'] == events[:5]
    assert len(events) == 6  # caller's list untouched


def test_high_frequency_owned_by_another_source_is_not_kit_evidence():
    hits = [.5 + i * .25 for i in range(64)]
    leak = render('hat', hits) * .01  # faint leak into the drum stem
    sibilance = render('hat', hits)   # the mixture's transient belongs elsewhere
    assert len(kit_onsets(leak, leak + sibilance, SR)) < MIN_ONSETS


def test_missing_drum_stem_keeps_events(tmp_path):
    events = [drum(1.)]
    kept, audit = gate_drum_events(events, tmp_path / 'missing.wav', tmp_path / 'missing-mix.wav')
    assert kept == events and audit['status'] == 'unavailable'


def test_no_drum_events_is_a_no_op():
    events = [pitched(1.)]
    assert gate_drum_events(events, None, None)[0] == events

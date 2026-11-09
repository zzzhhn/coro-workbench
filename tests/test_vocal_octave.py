import numpy as np
import soundfile as sf

from server.vocal_octave import adjudicate_vocal_octaves


def _render(tmp_path, low_harmonics, *, bass_in_mix=0., competing_midi=67):
    rate = 16_000
    time = np.arange(rate) / rate
    phase = 2 * np.pi * 196 * time + .26 * np.sin(2 * np.pi * 5 * time)
    vocal = sum(amplitude * np.sin(harmonic * phase) for harmonic, amplitude in low_harmonics)
    instrumental = bass_in_mix * np.sin(2 * np.pi * 195 * time)
    vf, mf = tmp_path / 'vocal.wav', tmp_path / 'mix.wav'
    sf.write(vf, vocal, rate, subtype='FLOAT')
    sf.write(mf, vocal + instrumental, rate, subtype='FLOAT')
    events = [{'source_start_seconds': .16, 'source_end_seconds': .78, 'midi_pitch': 55,
               'raw_midi_pitch': 54.99, 'start_seconds': .16, 'end_seconds': .78}]
    native = [{'start': .19, 'end': .75, 'midi': competing_midi}]
    return events, adjudicate_vocal_octaves(events, native, vocal_path=vf, mixture_path=mf)


def test_corrects_shared_subharmonic_error_with_mix_bass_leakage(tmp_path):
    events, (output, audit) = _render(tmp_path, [(1, .015), (2, .25), (4, .11), (6, .07)], bass_in_mix=.20)
    assert output == [dict(events[0], midi_pitch=67)]
    assert events[0]['midi_pitch'] == 55
    assert len(audit['edits']) == 1
    assert audit['edits'][0]['sourceEvent'] == events[0]


def test_real_lower_note_survives_even_harmonic_dominance(tmp_path):
    events, (output, audit) = _render(tmp_path, [(1, .06), (2, .25), (3, .08), (4, .15), (5, .03), (6, .05)])
    assert output == events
    assert not audit['edits']


def test_does_not_erase_strong_source_owned_subharmonic(tmp_path):
    events, (output, audit) = _render(tmp_path, [(1, .19), (2, .25), (4, .11), (6, .07)])
    assert output == events
    assert not audit['edits']


def test_non_octave_proposal_does_not_change_lead(tmp_path):
    events, (output, audit) = _render(tmp_path, [(2, .25), (4, .11), (6, .07)], competing_midi=68)
    assert output == events
    assert not audit['candidates']


def _render_attack(tmp_path, *, real_lower=False, interrupted=False):
    rate = 16_000
    time = np.arange(rate) / rate
    start, end = .16, .50
    offset = time - start
    upper_hz = 392. * 2 ** ((2 * np.clip((offset - .15) / .045, 0, 1)) / 12)
    if interrupted:
        upper_hz = np.where(offset < .15, 392., 440.)
    phase = 2 * np.pi * np.cumsum(upper_hz) / rate
    upper = .16 * np.sin(phase) + .075 * np.sin(2 * phase) + .04 * np.sin(3 * phase)
    # A real lower note follows the same glide and has a substantial,
    # phase-locked fundamental plus an odd harmonic of the lower series.
    low = ((.14 * np.sin(phase / 2) + .05 * np.sin(phase * 1.5)) if real_lower else
           .025 * np.sin(phase / 2))
    envelope = np.clip(offset / .025, 0, 1) * np.clip((end - time) / .025, 0, 1)
    if interrupted:
        envelope[(offset >= .115) & (offset <= .185)] = 0
    vocal = (upper + low) * envelope
    residual = .045 * np.sin(2 * np.pi * 220 * time)
    vf, mf = tmp_path / 'vocal.wav', tmp_path / 'mix.wav'
    sf.write(vf, vocal, rate, subtype='FLOAT')
    sf.write(mf, vocal + residual, rate, subtype='FLOAT')
    event = {'source_start_seconds': start, 'source_end_seconds': end, 'midi_pitch': 57}
    native = [{'start': .35, 'end': end, 'midi': 69}]
    return event, adjudicate_vocal_octaves([event], native, vocal_path=vf, mixture_path=mf)


def test_follows_upper_glide_to_the_target_without_losing_the_attack(tmp_path):
    event, (output, audit) = _render_attack(tmp_path)
    assert output == [dict(event, midi_pitch=69)]
    assert audit['edits'][0]['method'] == 'upper_attack_ridge'


def test_upper_ridge_cannot_erase_a_real_lower_glide(tmp_path):
    event, (output, audit) = _render_attack(tmp_path, real_lower=True)
    assert output == [event]
    assert not audit['edits']


def test_unconnected_high_tail_cannot_promote_an_entire_note(tmp_path):
    event, (output, audit) = _render_attack(tmp_path, interrupted=True)
    assert output == [event]
    assert not audit['edits']


def _render_continued_tone(tmp_path, *, new_lower_note=False):
    rate = 16_000
    time = np.arange(rate * 2) / rate
    phase = 2 * np.pi * 196 * time + .22 * np.sin(2 * np.pi * 5 * time)
    upper_envelope = np.clip((time - .25) / .05, 0, 1) * np.clip((1.57 - time) / .23, 0, 1)
    upper = upper_envelope * (.18 * np.sin(2 * phase) + .11 * np.sin(4 * phase) + .04 * np.sin(6 * phase))
    # The upper ridge stays constant in both examples. Only the second
    # acquires a sustained, dominant lower pitch through the event.
    low_envelope = np.clip((time - .68) / .18, 0, 1) * np.clip((1.57 - time) / .23, 0, 1)
    low = (.26 if new_lower_note else .065) * low_envelope * np.sin(phase)
    vocal = upper + low
    vf, mf = tmp_path / 'vocal.wav', tmp_path / 'mix.wav'
    sf.write(vf, vocal, rate, subtype='FLOAT')
    sf.write(mf, vocal, rate, subtype='FLOAT')
    event = {'source_start_seconds': .60, 'source_end_seconds': 1.60, 'midi_pitch': 55}
    native = [{'start': .28, 'end': 1.57, 'midi': 67}]
    return event, adjudicate_vocal_octaves([event], native, vocal_path=vf, mixture_path=mf)


def test_keeps_the_verified_upper_octave_across_a_late_subharmonic(tmp_path):
    event, (output, audit) = _render_continued_tone(tmp_path)
    assert output == [dict(event, midi_pitch=67)]
    assert audit['edits'][0]['method'] == 'anchored_upper_sustain'


def test_sustained_lower_dominance_overrules_an_earlier_upper_anchor(tmp_path):
    event, (output, audit) = _render_continued_tone(tmp_path, new_lower_note=True)
    assert output == [event]
    assert not audit['edits']

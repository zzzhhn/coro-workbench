import numpy as np
import pytest
import soundfile as sf

from server.piano_harmonics import reconcile_piano_harmonic_leaks


def note(midi, program, **fields):
    return dict(start=1., end=1.6, midi=midi, program=program, isDrum=False, **fields)


@pytest.fixture
def waveforms(tmp_path):
    rate = 44100
    time = np.arange(rate * 2) / rate
    root = 440 * 2 ** ((52 - 69) / 12)
    active = (time >= 1.) & (time < 1.68)
    piano = active * (.08 * np.sin(2 * np.pi * root * time) + .06 * np.sin(4 * np.pi * root * time))
    # Wide sources can cancel entirely on downmix. Analyze stereo directly.
    stereo_piano = np.column_stack((piano, -piano))
    mix, other, keyboard = (tmp_path / (name + '.wav') for name in ('mix', 'other', 'piano'))
    sf.write(keyboard, stereo_piano, rate, subtype='FLOAT')

    def write(independent_amplitude=0., detune=0.):
        independent = active * independent_amplitude * np.sin(2 * np.pi * (2 * root + detune) * time)
        stereo_other = np.column_stack((independent, independent))
        sf.write(mix, stereo_piano + stereo_other, rate, subtype='FLOAT')
        sf.write(other, stereo_other, rate, subtype='FLOAT')
        return mix, {'other': other, 'piano': keyboard}

    return write


def reconcile(waveforms, candidate, support=(), independent_amplitude=0., detune=0.):
    root = note(52, 0)
    measured_root = note(52, 0, activation=.9)
    mix, paths = waveforms(independent_amplitude, detune)
    return reconcile_piano_harmonic_leaks([root, candidate], [root], [measured_root], [measured_root],
                                         support, paths, mix)


def test_identifies_coherent_piano_partial_in_antiphase_stereo(waveforms):
    event = note(64, 48)
    result, audit = reconcile(waveforms, event)
    assert result == [note(52, 0)]
    assert audit['removedHarmonicAliases'] == 1
    assert audit['decisions'][0]['before'] == event
    assert audit['decisions'][0]['harmonic'] == 2


def test_detuned_independent_string_residual_vetoes_suppression(waveforms):
    event = note(64, 48)
    result, audit = reconcile(waveforms, event, independent_amplitude=.035, detune=3.2)
    assert result == [note(52, 0), event]
    assert audit['removedHarmonicAliases'] == 0


@pytest.mark.parametrize('candidate,support', [
    (note(64, 48), [note(64, 40)]),
    (note(64, 48, sourceId='violin'), []),
    (note(64, 48, evidenceOrigins=['independent_accompaniment_tail']), []),
])
def test_independent_string_identity_protects_an_exact_unison(waveforms, candidate, support):
    result, audit = reconcile(waveforms, candidate, support, independent_amplitude=.004)
    assert result == [note(52, 0), candidate]
    assert audit['removedHarmonicAliases'] == 0


def test_requires_both_independent_piano_views(waveforms):
    root, candidate = note(52, 0), note(64, 48)
    mix, paths = waveforms()
    result, audit = reconcile_piano_harmonic_leaks([root, candidate], [root], [note(52, 0, activation=.9)],
                                                 [], [], paths, mix)
    assert result == [root, candidate]
    assert audit['removedHarmonicAliases'] == 0


@pytest.mark.parametrize('invalid', ['mismatched_frames', 'nonfinite_samples'])
def test_unusable_waveform_retains_existing_candidate(waveforms, invalid):
    root, candidate = note(52, 0), note(64, 48)
    measured = note(52, 0, activation=.9)
    mix, paths = waveforms()
    audio, rate = sf.read(paths['other'], dtype='float32', always_2d=True)
    if invalid == 'mismatched_frames':
        audio = audio[:-1]
    else:
        audio[rate] = np.nan
    sf.write(paths['other'], audio, rate, subtype='FLOAT')
    result, audit = reconcile_piano_harmonic_leaks([root, candidate], [root], [measured], [measured],
                                                 [], paths, mix)
    assert result == [root, candidate]
    assert audit['examinedCandidates'] == 1
    assert audit['removedHarmonicAliases'] == 0

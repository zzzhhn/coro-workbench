import copy

import numpy as np

from server.piano_consensus import reconcile_piano


def note(pitch=60, start=1., end=2., program=0, **extra):
    return dict(midi=pitch, start=start, end=end, program=program, isDrum=False, **extra)


def energies(piano=1., vocals=0., other=0.):
    return {k: np.full((128, 500), v) for k, v in dict(piano=piano, vocals=vocals, other=other).items()}


def test_duplicate_decoder_classes_are_one_attack_only_with_shared_piano_evidence():
    native = [note(sourceId='piano'), note(program=2, sourceId='piano')]
    before = copy.deepcopy(native)
    measured = [note(activation=.9)]
    fixed, audit = reconcile_piano(native, measured, measured, energies())
    assert native == before
    assert len(fixed) == 1 and fixed[0]['program'] == 0
    assert audit['removedDuplicateClasses'] == 1
    assert audit['decisions'][0]['before']['program'] == 2


def test_different_keyboard_sources_and_unconfirmed_classes_remain_distinct():
    separate = [note(sourceId='piano-a'), note(program=2, sourceId='piano-b')]
    measured = [note(activation=.9)]
    assert len(reconcile_piano(separate, measured, measured, energies())[0]) == 2
    assert len(reconcile_piano([note(), note(program=2)], [], [], energies())[0]) == 2


def test_missing_attack_needs_both_views_and_source_support():
    measured = [note(64, activation=.9)]
    fixed, audit = reconcile_piano([note(60, start=0., end=.5)], measured, measured, energies())
    assert [n['midi'] for n in fixed] == [60, 64]
    assert audit['addedConsensusNotes'] == 1
    assert len(reconcile_piano([], measured, [], energies())[0]) == 0
    assert len(reconcile_piano([], measured, measured, energies(piano=.01, vocals=1.))[0]) == 0


def test_harmonic_double_and_short_noisy_detection_stay_pending():
    measured = [note(72, activation=.95)]
    fixed, audit = reconcile_piano([note(60)], measured, measured, energies())
    assert len(fixed) == 1 and audit['pendingCandidates']
    assert not reconcile_piano([], [note(end=1.01, activation=.99)], [note(end=1.01, activation=.99)], energies())[0]


def test_repeated_syllable_or_sustain_does_not_become_piano_duplicate():
    measured = [note(64, start=1.1, activation=.9)]
    native = [note(64, start=1., end=2.)]
    assert len(reconcile_piano(native, measured, measured, energies())[0]) == 1


def test_extended_class_alias_needs_track_containment_and_acoustic_corroboration():
    native = [note(60+i,start=float(i*2),end=float(i*2+1),program=p,sourceId='piano')
              for i in range(6) for p in (0,2)]
    measured = [note(60+i,start=float(i*2),end=float(i*2+1),activation=.9) for i in range(2)]
    fixed,audit = reconcile_piano(native,measured,measured,energies())
    assert len(fixed)==6 and audit['duplicateClassFingerprint']
    native[-1]['midi']=80  # an independent phrase no longer forms an alias
    assert not reconcile_piano(native,measured,measured,energies())[1]['duplicateClassFingerprint']


def test_matching_piano_releases_can_shorten_native_tail_but_never_extend_it():
    native=[note(end=3.)]; measured=[note(end=1.5,activation=.9)]
    fixed,audit=reconcile_piano(native,measured,measured,energies())
    assert fixed[0]['end']==1.5 and fixed[0]['acousticEnd']==3.
    assert audit['corroboratedReleases']==1
    assert reconcile_piano([note(end=1.2)],measured,measured,energies())[0][0]['end']==1.2

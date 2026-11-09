import copy

import numpy as np

from server.piano_consensus import reconcile_piano
from server.piano_consensus import recover_piano_reattacks


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


def test_repeated_chord_recovers_a_swallowed_inner_reattack():
    native = [note(48, end=4., sourceId='piano'), note(64, end=3., sourceId='piano')]
    native += [note(p, start=t, end=t+1, sourceId='piano') for t in (1., 2.) for p in (60, 67)]
    measured = [note(64, start=2.01, end=3., activation=.75)]
    before = copy.deepcopy(native)
    fixed, audit = recover_piano_reattacks(native, measured, measured)
    assert native == before
    assert [(n['start'], n['end']) for n in fixed if n['midi']==64] == [(1., 2.01), (2.01, 3.)]
    assert next(n for n in fixed if n['midi']==48)['end'] == 4.
    assert len(audit) == 1


def test_held_note_over_changing_harmony_is_not_a_repeated_chord():
    native = [note(64, end=3., sourceId='piano')]
    native += [note(p, start=1., sourceId='piano') for p in (60, 67)]
    native += [note(p, start=2., end=3., sourceId='piano') for p in (59, 65)]
    measured = [note(64, start=2.01, end=3., activation=.75)]
    assert recover_piano_reattacks(native, measured, measured)[0] == native
    # One model view or a different instrument cannot establish a reattack.
    assert recover_piano_reattacks(native, measured, [])[0] == native
    other = [dict(n, sourceId='other-piano') for n in native]
    assert recover_piano_reattacks(other, measured, measured)[0] == other


def test_strong_two_view_reattack_can_complete_a_regular_run():
    native = [note(62,start=.5,end=3.,sourceId='piano')]
    native += [note(p,start=t,end=3.,sourceId='piano') for p,t in [(60,1.),(64,1.5),(67,1.75)]]
    measured = [note(62,start=1.25,end=3.,activation=.9)]
    fixed,audit = recover_piano_reattacks(native,measured,measured)
    assert len(fixed)==5 and audit[0]['context']=='regular_run'
    assert next(n for n in fixed if n['midi']==62 and n['start']==.5)['end']==1.25
    # One view's weak retrigger and a nonuniform rhythm remain unmodified.
    assert recover_piano_reattacks(native,measured,[dict(measured[0],activation=.7)])[0]==native
    native[-1]['start']=2.2
    assert recover_piano_reattacks(native,measured,measured)[0]==native

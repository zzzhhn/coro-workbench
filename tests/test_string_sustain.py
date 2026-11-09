import numpy as np

from server.string_sustain import (
    merge_string_program_duplicates,
    reconcile_string_sustains,
    recover_string_unisons,
)


def note(pitch=66, start=1., end=1.2, program=48, **extra):
    return dict(midi=pitch, start=start, end=end, program=program, isDrum=False, **extra)


def fixture():
    envelopes={k:np.zeros((128,700)) for k in ['other','piano','vocals']}
    envelopes['piano'][66,100:120]=100
    envelopes['other'][66,150:400]=10
    return envelopes


def test_bowed_sustain_hidden_by_piano_attack_survives_as_separate_part():
    piano=note(program=0,evidenceOrigins=['yourmt3_mix'])
    bp=[note(start=1.5,end=4.,activation=.72)]
    support=[note(start=1.,end=1.65)]
    out,audit=reconcile_string_sustains([piano],bp,support,fixture(),lambda _:dict(independent=True,attackRise=1.))
    assert [(n['program'],n['start'],n['end']) for n in out]==[(0,1.,1.2),(48,1.,4.)]
    assert audit['addedSustains']==1
    assert piano['end']==1.2


def test_same_pitch_sustain_is_not_written_as_repeated_model_fragments():
    bp=[note(start=1.5,end=2.,activation=.72),note(start=2.01,end=4.,activation=.7)]
    out,audit=reconcile_string_sustains([],bp,[note(start=1.4,end=4.)],fixture(),lambda _:dict(independent=True,attackRise=1.))
    assert len(out)==1
    assert (out[0]['start'],out[0]['end'])==(1.4,4.)


def test_new_attack_is_preserved_in_bowed_phrase():
    bp=[note(start=1.5,end=3.6,activation=.72),note(start=3.61,end=6.,activation=.7)]
    out,_=reconcile_string_sustains([],bp,[note(start=1.4,end=6.)],fixture(),lambda _:dict(independent=True,attackRise=4.))
    assert len(out)==2


def test_piano_leak_and_unclassified_residual_never_become_strings():
    bp=[note(start=1.5,end=4.,activation=.72)]
    out,_=reconcile_string_sustains([],bp,[],fixture(),lambda _:dict(independent=True,attackRise=1.))
    assert out==[]
    out,_=reconcile_string_sustains([],bp,[note(start=1.4,end=4.)],fixture(),lambda _:dict(independent=False,attackRise=1.))
    assert out==[]


def test_piano_duplicate_class_removed_only_with_independent_piano_support():
    env=fixture();env['other'][:]=0
    raw=[note(program=0),note(program=40)]
    strong=[note(program=0,activation=.9)]
    out,audit=reconcile_string_sustains(raw,[],[],env,lambda _:dict(independent=False,attackRise=1.),piano_notes=strong)
    assert len(out)==1 and out[0]['program']==0
    assert audit['removedPianoDuplicates']==1
    explicit=[raw[0],dict(raw[1],sourceId='violin-1')]
    out,_=reconcile_string_sustains(explicit,[],[],env,lambda _:dict(independent=False,attackRise=1.),piano_notes=strong)
    assert out==explicit


def test_independent_sustain_preserves_piano_string_unison():
    env=fixture();env['piano'][66,100:400]=100
    raw=[note(program=0,end=4.),note(program=40,end=4.)]
    bp=[note(start=1.,end=4.,activation=.8)]
    out,_=reconcile_string_sustains(raw,bp,[note(end=4.)],env,lambda _:dict(independent=True,attackRise=1.),piano_notes=[note(program=0,end=4.,activation=.9)])
    assert len(out)==2 and {n['program'] for n in out}=={0,40}


def test_two_explicit_string_players_are_never_collapsed():
    raw=[note(end=4.,sourceId='violin-1'),note(end=4.,sourceId='violin-2')]
    out,_=reconcile_string_sustains(raw,[note(start=1.,end=4.,activation=.8)],[note(end=4.)],fixture(),lambda _:dict(independent=True,attackRise=1.))
    assert out==raw


def test_short_unanchored_support_stays_candidate_not_new_string_part():
    bp=[note(start=1.,end=2.,activation=.9)]
    out,audit=reconcile_string_sustains([],bp,bp,fixture(),lambda _:dict(independent=True,attackRise=1.))
    assert out==[]
    assert any(x['reason']=='insufficient_sustain_span' for x in audit['pending'])


def test_recovery_does_not_shorten_an_existing_supported_release():
    raw=[note(start=1.,end=4.)]
    bp=[note(start=1.2,end=3.5,activation=.8)]
    out,_=reconcile_string_sustains(raw,bp,bp,fixture(),lambda _:dict(independent=True,attackRise=1.))
    assert out==raw


def test_competing_octaves_do_not_both_gain_sustain_from_same_residual():
    bp=[note(pitch=69,start=1.,end=4.,activation=.8),note(pitch=81,start=1.,end=4.,activation=.8)]
    out,audit=reconcile_string_sustains([],bp,bp,fixture(),lambda _:dict(independent=True,attackRise=1.))
    assert out==[]
    assert any(x['reason']=='octave_identity_ambiguous' for x in audit['pending'])


def test_recover_hidden_string_unison_requires_a_real_independent_tail(tmp_path):
    import soundfile as sf

    rate = 22050
    time = np.arange(rate * 5) / rate
    pitch = 67
    f0 = 440 * 2 ** ((pitch - 69) / 12)
    bow = .01 * np.minimum(np.clip((time - 1.85) * 6, 0, 1), np.clip((4.1 - time) * 6, 0, 1))
    vocal = .08 * np.sin(2 * np.pi * f0 * time) * ((time >= 2.) & (time < 3.))
    tone = bow * sum(weight * np.sin(2 * np.pi * h * f0 * time)
                     for h, weight in [(1, 1), (2, .3), (3, .2)])
    piano = np.zeros_like(time)
    paths = {key: tmp_path / (key + '.wav') for key in ('other', 'piano', 'vocals', 'mix')}
    for key, audio in [('piano', piano), ('vocals', vocal), ('other', tone), ('mix', tone + vocal)]:
        sf.write(paths[key], audio, rate, subtype='FLOAT')
    anchor = note(69, 1.5, 4.3, evidenceOrigins=['sustained_harmonics'])
    lead = note(pitch, 2., 3., program=100, sourceId='vocals')
    out, audit = recover_string_unisons([anchor, lead], [lead], paths, paths['mix'])
    assert audit['addedUnisons'] == 1
    recovered = next(n for n in out if n['midi'] == pitch and n['program'] == 48)
    assert 1.88 <= recovered['start'] <= 2.05
    assert 3.7 <= recovered['end'] <= 4.1
    assert lead in out

    # The same strong upper partial can instead belong to a lower fundamental.
    harmonic = tone + 2.5 * bow * np.sin(np.pi * f0 * time)
    sf.write(paths['other'], harmonic, rate, subtype='FLOAT')
    sf.write(paths['mix'], harmonic + vocal, rate, subtype='FLOAT')
    out, audit = recover_string_unisons([anchor, lead], [lead], paths, paths['mix'])
    assert out == [anchor, lead]
    assert audit['addedUnisons'] == 0

    # A measured tail without independent string-family support is ambiguous.
    out, audit = recover_string_unisons([lead], [lead], {}, None)
    assert out == [lead]
    assert audit['addedUnisons'] == 0


def test_merge_identical_anonymous_string_labels_preserves_distinct_sources_and_attacks():
    first = note(program=40, evidenceOrigins=['yourmt3_mix'])
    duplicate = note(program=41, evidenceOrigins=['yourmt3_instrumental'])
    independent = [note(program=40, sourceId='violin-1'), note(program=41, sourceId='viola-1')]
    other_attacks = [note(program=41, start=1.01), note(program=41, end=1.21), note(67, program=41)]
    out, audit = merge_string_program_duplicates([first, duplicate, *independent, *other_attacks])
    assert audit['mergedLabelEvents'] == audit['removedLabelDuplicates'] == 1
    assert all(n in out for n in independent + other_attacks)
    merged = next(n for n in out if n.get('candidatePrograms'))
    assert (merged['start'], merged['end'], merged['midi'], merged['program']) == (1., 1.2, 66, 48)
    assert merged['candidatePrograms'] == [40, 41]
    assert merged['evidenceOrigins'] == ['yourmt3_instrumental', 'yourmt3_mix']
    assert audit['decisions'][0]['before'] == [first, duplicate]

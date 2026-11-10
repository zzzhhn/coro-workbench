import numpy as np

from server.multi_sources import fuse_sources, piano_finger_durations, notation_key


def note(pitch=60, start=1., end=1.5, program=0, **extra):
    return dict(midi=pitch, start=start, end=end, program=program, isDrum=False, **extra)


def energy(piano=1., vocals=0., other=0.):
    return {key: np.full((128, 400), value, dtype=np.float32)
            for key, value in dict(piano=piano, vocals=vocals, other=other).items()}


def test_complementary_piano_note_is_not_lost_to_intersection():
    native = [note(60)]
    independent = [note(64, activation=.85)]
    result = fuse_sources(native, independent, [], energy())
    assert [e['midi'] for e in result['events']] == [60, 64]
    assert result['sourceRefinement']['actions'] == {'add': 1}
    assert native == [note(60)]


def test_piano_model_vocal_leakage_is_not_added_to_piano():
    leaked = note(72, activation=.99)
    result = fuse_sources([], [leaked], [], energy(piano=.05, vocals=1.))
    assert result['events'] == []
    assert result['sourceRefinement']['reviewCandidates'][0]['event'] == leaked


def test_source_and_independent_attack_correct_instrument_label():
    native = [note(program=48)]
    result = fuse_sources(native, [note(start=1.04, activation=.9)], [], energy())
    assert len(result['events']) == 1
    assert result['events'][0]['program'] == 0
    assert result['events'][0]['start'] == 1.
    edit = result['sourceRefinement']['decisions'][0]
    assert edit['before']['program'] == 48 and edit['after']['program'] == 0


def test_simultaneous_piano_and_voice_are_not_deduplicated():
    # Piano has source-supported evidence at its attack, vocals in its own
    # delayed onset window. Both remain plausible despite near-unison timing.
    envelopes = energy(piano=1.)
    envelopes['piano'][:, 117:] = .05
    envelopes['vocals'][:, 117:] = 1.
    result = fuse_sources([note(program=100, start=1.1)],
                          [note(start=1., end=1.12, activation=.9)],
                          [note(start=1.1, program=100)], envelopes)
    assert {e['program'] for e in result['events']} == {0, 100}
    assert len(result['events']) == 2


def test_phoneme_boundary_does_not_double_a_held_vocal_note():
    result = fuse_sources([note(program=100, end=2.)], [],
                          [note(program=100, start=1.3, end=1.8)], energy(piano=0., vocals=1.))
    assert len(result['events']) == 1
    assert result['sourceRefinement']['reviewCandidates'][0]['reason'] == 'overlapping_same_pitch_native_vocal'


def test_known_same_class_sources_keep_their_identity_and_unison():
    native = [note(sourceId='piano-left', sourceLabel='Piano 1'),
              note(sourceId='piano-right', sourceLabel='Piano 2')]
    result = fuse_sources(native, [], [], energy())
    assert [e['sourceId'] for e in result['events']] == ['piano-left', 'piano-right']
    assert len(result['events']) == 2


def test_measured_pedal_run_crosses_hands_without_stacking_sustain():
    native = [note(pitch=pitch, start=i*.5, end=4.) for i,pitch in enumerate([38,45,52,54,62,69,74,78])]
    fixed, edits = piano_finger_durations(native, [{'onset_time':0.,'offset_time':4.}])
    assert [n['end']-n['start'] for n in fixed[:7]] == [.5]*7
    assert len(edits)==7 and all(n['end']==4. for n in native)
    assert fixed[3]['acousticEnd']==4.


def test_pedal_run_does_not_cut_rolled_chords_or_unpedalled_notes():
    rolled = [note(pitch=pitch,start=i*.06,end=3.) for i,pitch in enumerate([48,55,60,64,67])]
    assert piano_finger_durations(rolled,[{'onset_time':0.,'offset_time':3.}])[0] == rolled
    run = [note(pitch=48+i*2,start=i*.5,end=3.) for i in range(4)]
    assert piano_finger_durations(run,[])[0] == run


def test_keyboard_chord_register_gap_keeps_lower_hand_above_middle_c():
    from server.score_rhythm import assign_keyboard_staves
    notes=[{'midi':pitch,'start':i*.0625,'duration':3.5} for i,pitch in enumerate([52,55,58,62,70,74,78])]
    assign_keyboard_staves(notes)
    assert [n['staff'] for n in notes] == [2,2,2,2,1,1,1]
    arpeggio=[{'midi':pitch,'start':i*.5,'duration':.5} for i,pitch in enumerate([38,45,52,54,62,69,74,78])]
    assign_keyboard_staves(arpeggio)
    assert [n['staff'] for n in arpeggio] == [2,2,2,2,1,1,1,1]


def test_keyboard_low_right_hand_chord_is_not_all_assigned_to_the_bass_staff():
    from server.score_rhythm import assign_keyboard_staves
    notes=[dict(midi=p,start=0.,duration=1.) for p in [40,43,47,50,55,59,62]]
    assign_keyboard_staves(notes)
    assert [n['staff'] for n in notes]==[2,2,2,2,1,1,1]
    wide=[dict(midi=p,start=0.,duration=1.) for p in [50,55,60,62,67,72,74,76,81]]
    assign_keyboard_staves(wide)
    assert max(sum(n['staff']==staff for n in wide) for staff in (1,2))<=5


def test_notation_key_uses_notes_without_transposing_and_abstains_when_ambiguous():
    rows=[note(pitch=pitch,start=float(i),end=float(i+1)) for i,pitch in enumerate([62,66,69,74]*15)]
    key,audit=notation_key(rows,'E')
    assert key=='D' and audit['audioEstimate']=='E' and rows[0]['midi']==62
    uniform=[note(pitch=60+i%12) for i in range(60)]
    assert notation_key(uniform,'C')[0]=='C'


def test_default_source_proposal_preserves_native_count_and_keeps_additions_separate(tmp_path, monkeypatch):
    import json
    import server.multi_source_runtime as runtime
    (tmp_path/'models.json').write_text(json.dumps({'engines':{'piano':'fixture'},'errors':{}}))
    (tmp_path/'piano.json').write_text(json.dumps({'notes':[[1.,1.5,64,.8,.9]],'pedals':[]}))
    monkeypatch.setattr(runtime,'harmonic_source_evidence',lambda *args:energy())
    result=runtime.build_source_proposal(tmp_path,{'events':[note(60)]},{},tmp_path,[])
    assert len(result['events'])==1 and len(result['candidateEvents'])==2
    assert result['sourceRefinement']['pendingAdditionalNotes']==1
    assert result['sourceRefinement']['decisions'][0]['applied'] is False


def test_score_rebuild_uses_the_selected_refined_events_and_preserves_stem_links(tmp_path):
    import json
    from server.score_rebuild import rebuild
    project={'id':'saved','tempo':120,'timeSignature':[4,4],'parts':[{'id':'piano-0-piano','stemUrl':'/api/audio/saved/stem-piano.wav'}],
             'originalAudio':{'offsetSeconds':0},'source':{'warnings':[], 'analysis':{'transforms':[],
             'quality':{'sourceRefinementVersion':'multiscore-sources-1'}}}}
    files={'project.json':project,'multi-events.json':{'events':[note(60)]},
           'multi-source-events.json':{'events':[note(64,sourceId='piano')],'sourceRefinement':{'version':'multiscore-sources-1'}},
           'analysis-evidence.json':{'analyzedDurationSeconds':3}}
    for filename,value in files.items():(tmp_path/filename).write_text(json.dumps(value))
    result,audit=rebuild(tmp_path)
    assert result['parts'][0]['notes'][0]['midi']==64
    assert result['parts'][0]['stemUrl']=='/api/audio/saved/stem-piano.wav'
    assert audit['sourceRefinementVersion']=='multiscore-sources-1'


def test_score_rebuild_prints_pedal_changes_at_harmony_like_the_upload(tmp_path):
    import json
    from server.score_rebuild import rebuild
    from server.score_rhythm import notated_pedals
    project={'id':'saved','tempo':60,'timeSignature':[4,4],'parts':[{'id':'piano-0-piano'}],
             'originalAudio':{'offsetSeconds':0},'source':{'warnings':[], 'analysis':{'transforms':[],
             'rhythm':{'bpm':60,'offsetSeconds':0},'quality':{'sourceRefinementVersion':'multiscore-sources-1'}}}}
    events=[note(48,0,3.9,sourceId='piano'),note(52,0,3.9,sourceId='piano'),note(55,0,3.9,sourceId='piano'),
            note(43,4,7.9,sourceId='piano'),note(47,4,7.9,sourceId='piano'),note(50,4,7.9,sourceId='piano')]
    pedals=[{'onset_time':0.,'offset_time':3.95},{'onset_time':4.05,'offset_time':7.9}]
    files={'project.json':project,'multi-events.json':{'events':events},
           'multi-source-events.json':{'events':events,'sourceRefinement':{'version':'multiscore-sources-1','pianoPedals':pedals}},
           'analysis-evidence.json':{'analyzedDurationSeconds':8},'request.json':{'tempo':60}}
    for filename,value in files.items():(tmp_path/filename).write_text(json.dumps(value))
    result,_=rebuild(tmp_path)
    piano=next(p for p in result['parts'] if 'pedals' in p)
    total=max(n['start']+n['duration'] for n in piano['notes'])
    expected=notated_pedals(pedals,1.,0.,total,chord_starts=[c['start'] for c in result['chords']])
    assert piano['pedals']==expected
    # The quick re-pedal at 4 s coincides with the harmony change, so it prints as a change.
    assert len(piano['pedals'])==2

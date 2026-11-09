import copy
import json

import pytest

from server.score_rhythm import infer_part_rhythm, infer_notation_grid


def rhythm(events, **kwargs):
    return infer_part_rhythm(events, {'bpm': 120, 'offsetSeconds': 0}, 20, 'test', **kwargs)


def test_detached_eighths_are_written_as_notes_with_staccato_not_tiny_rests():
    events = [[i * .25 + .006, i * .25 + .13, 60 + i % 5, .8] for i in range(16)]
    before = copy.deepcopy(events)
    notes, audit = rhythm(events, program=0)
    assert events == before
    assert [n['start'] for n in notes] == [i / 2 for i in range(16)]
    assert all(n['duration'] == .5 and n['articulation'] == 'staccato' for n in notes[:-1])
    assert audit['editorialTiming'] and audit['maximumOffsetShiftSeconds'] > .025


def test_joint_fast_run_preserves_every_attack_and_does_not_relay_between_voices():
    # Jitter is enough to make independent rounding collide at one subdivision.
    events = [[1 + i / 16 + (.02 if i == 6 else -.018 if i == 7 else 0),
               1 + i / 16 + .075, 72 + i % 8, .8] for i in range(16)]
    events += [[1, 3, 48, .8]]
    notes, _ = rhythm(events, program=8)
    run = [n for n in notes if n['midi'] >= 72]
    assert len(run) == 16
    assert [n['start'] for n in run] == [2 + i / 8 for i in range(16)]
    assert len(set(n['voice'] for n in run)) == 1
    assert next(n for n in notes if n['midi'] == 48)['duration'] == 4


def test_complete_triplet_survives_but_an_odd_release_does_not_create_tuplets():
    notes, audit = rhythm([[i / 6, (i + 1) / 6 - .008, 60 + i, .8] for i in range(3)])
    assert [n['start'] for n in notes] == pytest.approx([0, 1 / 3, 2 / 3])
    assert [n['duration'] for n in notes] == pytest.approx([1 / 3] * 3)
    assert audit['tripletHalfBeats'] == [0, 1]
    notes, audit = rhythm([[0, .267, 60, .8], [1, 1.49, 62, .8]])
    assert audit['tripletHalfBeats'] == []
    assert all(n['duration'] * 16 == round(n['duration'] * 16) for n in notes)


def test_late_returning_ornament_keeps_one_triplet_and_a_landing_note():
    # Expressive three-note turn, delayed first attack, anchored long landing.
    rows = [[0., 2.12, 70, .8], [2.12, 2.34, 70, .8],
            [2.28, 2.34, 71, .8], [2.34, 2.49, 70, .8], [2.5, 4., 68, .8]]
    notes, audit = infer_part_rhythm(rows, {'bpm':60, 'offsetSeconds':0}, 5, 'piano', program=0)
    turn = notes[1:4]
    assert [n['start'] for n in turn] == pytest.approx([2, 2+1/6, 2+2/6])
    assert [n['duration'] for n in turn] == pytest.approx([1/6]*3)
    assert notes[4]['start'] == 2.5
    assert audit['ornamentTripletGroups'] == 1


def test_three_slightly_early_attacks_stay_inside_the_same_half_beat_triplet():
    notes,audit=infer_part_rhythm([[2.466,2.64,51,.8],[2.64,2.813,55,.8],[2.813,2.98,59,.8]],
                                 {'bpm':60,'offsetSeconds':0},4,'piano',program=0)
    assert [n['start'] for n in notes]==pytest.approx([2.5,2.5+1/6,2.5+2/6])
    assert audit['tripletHalfBeats']==[5]


def test_left_hand_triplet_does_not_put_independent_right_hand_on_a_triplet_grid():
    rows=[[2.466,2.64,51,.8],[2.64,2.813,55,.8],[2.813,2.98,59,.8],
          [2.75,3.25,74,.8]]
    notes,audit=infer_part_rhythm(rows,{'bpm':60,'offsetSeconds':0},4,'piano',program=0)
    right=next(n for n in notes if n['midi']==74)
    assert right['start']==2.75 and right['duration']==.5
    assert [n['start'] for n in notes if n['midi']<60]==pytest.approx([2.5,2.5+1/6,2.5+2/6])


def test_rolled_chord_does_not_extend_early_releases_to_the_other_fingers():
    rows = [[2+i*.04, end, pitch, .8] for i,(pitch,end) in enumerate(
        [(48,4.),(52,8.),(55,8.),(59,5.),(67,6.),(71,6.),(74,6.)])]
    notes, _ = rhythm(rows, program=0)
    first = next(n for n in notes if n['midi']==48)
    assert first.get('arpeggio')
    assert first['start']+first['duration'] <= 8.25  # original release 4s at 120 BPM
    assert next(n for n in notes if n['midi']==52)['duration'] > first['duration']


def test_left_hand_anticipation_does_not_cut_the_right_hand_eighth():
    rows = [[8.36,8.84,38,.8],[8.84,9.28,45,.8],[9.28,9.74,52,.8],[9.74,10.19,54,.8],
            [10.19,10.65,62,.8],[10.65,11.13,69,.8],[11.13,11.58,74,.8],[11.58,12.,81,.8],
            [11.9,15.74,52,.8],[11.93,15.74,55,.8],[11.99,15.74,58,.8],
            [12.05,12.287625,70,.8],[12.09,15.74,62,.8],[12.11,14.3355625,74,.8],[12.21,13.63,81,.8]]
    notes,_ = infer_part_rhythm(rows,{'bpm':64.998,'offsetSeconds':-2.702262},16,'piano',program=0)
    assert next(n for n in notes if n['midi']==81 and n['start']<16)['duration']==.5


def test_final_left_hand_roll_does_not_write_pedal_tail_past_cadential_handoff():
    rows = [[i*.04,10.,pitch,.8] for i,pitch in enumerate([48,55,59,64,67,71])]
    rows += [[4.,8.,84,.8]]
    notes,audit = infer_part_rhythm(rows,{'bpm':60,'offsetSeconds':0},12,'piano',program=0)
    assert max(n['start']+n['duration'] for n in notes if n['midi']<60)==4
    assert any(c['reason']=='terminal_keyboard_handoff' for c in audit['boundaryChanges'])


def test_real_rest_and_independent_sustain_are_preserved():
    notes, _ = rhythm([[0, 2, 48, .8], [0, .25, 72, .8], [1, 1.25, 74, .8]])
    assert notes[0]['duration'] == 4
    short = next(n for n in notes if n['midi'] == 72)
    assert short['duration'] == .5
    assert (short.get('staff'), short['voice']) != (notes[0].get('staff'), notes[0]['voice'])


def test_duplicate_unisons_and_drum_hits_are_not_deleted():
    notes, _ = rhythm([[0, .01, 38, .8], [.5, .51, 38, .8]], percussion=True)
    assert [(n['start'], n['duration']) for n in notes] == [(0, 1), (1, .5)]
    notes, _ = rhythm([[0, .5, 60, .8], [0, .5, 60, .8]])
    assert len(notes) == 2 and len(set(n['voice'] for n in notes)) == 2


def test_piano_roll_is_a_chord_but_fast_detached_run_remains_sequential():
    events = [[2+i*.04, 4., pitch, .8] for i,pitch in enumerate([48,55,60,64,67])]
    notes, audit = rhythm(events, program=0)
    assert len(notes)==5 and len({n['start'] for n in notes})==1
    assert all(n.get('arpeggio') for n in notes)
    assert [n.get('arpeggioOffset') for n in notes] == pytest.approx([0, .08, .16, .24, .32])
    assert any(c['reason']=='rolled_chord_notation' for c in audit['boundaryChanges'])
    run = [[2+i*.04,2+i*.04+.08,pitch,.8] for i,pitch in enumerate([60,62,64,65,67])]
    notes,_=rhythm(run,program=0)
    assert len({n['start'] for n in notes})==5 and not any(n.get('arpeggio') for n in notes)


def test_notation_unit_requires_fast_passages_and_honors_explicit_tempo():
    events = [{'start': i * .05, 'end': i * .05 + .07, 'midi': 60, 'program': 8, 'isDrum': False} for i in range(40)]
    grid = {'bpm': 75, 'offsetSeconds': 0}
    assert infer_notation_grid(events, grid)['bpm'] == 150
    assert infer_notation_grid(events, grid, tempo_locked=True)['bpm'] == 75
    assert infer_notation_grid(events[:4], grid)['bpm'] == 75


def test_shared_onset_phase_corrects_tracker_delay_without_following_one_player():
    events = [{'start': i * .25, 'end': i * .25 + .1, 'midi': 60,
               'program': program, 'isDrum': False} for program in (0, 24) for i in range(24)]
    grid = infer_notation_grid(events, {'bpm': 120, 'offsetSeconds': .024})
    assert grid['offsetSeconds'] == 0
    assert grid['onsetPhaseCorrectionSeconds'] == -.024
    assert grid['onsetPhaseSupportPrograms'] == [0, 24]
    notes, _ = infer_part_rhythm([[e['start'], e['end'], e['midi'], .8]
                                 for e in events if e['program'] == 0], grid, 6, 'piano')
    assert [n['start'] for n in notes] == [i / 2 for i in range(24)]
    single = infer_notation_grid(events[:24], {'bpm': 120, 'offsetSeconds': .024})
    assert single['onsetPhaseCorrectionSeconds'] == 0
    # Independent players on opposite sides of the pulse do not establish a
    # shared tracker bias. Their phrasing must not shift the whole score.
    for event in events:
        if event['program'] == 24:
            event['start'] += .05
            event['end'] += .05
    split = infer_notation_grid(events, {'bpm': 120, 'offsetSeconds': .024})
    assert split['onsetPhaseCorrectionSeconds'] == 0


def test_very_short_releases_do_not_become_full_beat_staccatos():
    notes, _ = rhythm([[i * .5, i * .5 + .08, 60, .8] for i in range(8)], program=0)
    assert all(n['duration'] == .5 and n.get('articulation') == 'staccato' for n in notes[:-1])


def test_chord_release_jitter_does_not_create_independent_rhythm_voices():
    events = [[i * .25, i * .25 + gate, pitch, .8]
              for i in range(16) for pitch, gate in [(60, .055), (64, .08), (67, .085)]]
    events.append([0, 2, 48, .8])
    notes, audit = rhythm(events, program=26)
    chord = [n for n in notes if n['start'] == 0 and n['midi'] >= 60]
    assert len(chord) == 3
    assert len(set((n['duration'], n['voice'], n.get('articulation')) for n in chord)) == 1
    assert chord[0]['duration'] == .5
    assert next(n for n in notes if n['midi'] == 48)['duration'] == 4
    assert any(c['reason'] == 'shared_chord_release' for c in audit['boundaryChanges'])


def test_last_detached_attack_keeps_the_phrase_rhythm_before_silence():
    events = [[i * .25, i * .25 + .10, 60 + i % 3, .8] for i in range(8)]
    notes, _ = rhythm(events, program=26)
    assert notes[-1]['duration'] == .5 and notes[-1]['articulation'] == 'staccato'
    events.append([4, 5, 60, .8])
    notes, _ = rhythm(events, program=26)
    assert notes[-2]['duration'] == .5 and notes[-2]['articulation'] == 'staccato'
    assert notes[-2]['start'] + notes[-2]['duration'] < notes[-1]['start']


def test_rapid_layer_does_not_fill_an_intentional_rest_before_the_next_phrase():
    events = [[i / 16, i / 16 + .055, 72 + i % 8, .8] for i in range(16)]
    events += [[15 / 16 + .25, 15 / 16 + .30, 72, .8]]
    events += [[i * 2, i * 2 + 1, 48, .8] for i in range(8)]
    notes, _ = rhythm(events, program=8)
    last = next(n for n in notes if n['midi'] == 79 and n['start'] == 15 / 8)
    assert last['duration'] == .125


def test_rebuild_endpoint_creates_a_separate_audited_score_and_keeps_source(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from server.app import create_app
    from server import config
    monkeypatch.setattr(config, 'engine_health', lambda: {})
    job = 'b' * 32
    source = tmp_path / job
    source.mkdir()
    project = {'id': job, 'title': 'Song', 'tempo': 120, 'measures': 2, 'timeSignature': [4, 4],
               'parts': [], 'source': {'kind': 'audio', 'warnings': [], 'analysis': {'transforms': [],
               'rawProjectUrl': f'/api/projects/{job}/raw', 'quality': {'decoderProfile': 'yourmt3'}}},
               'originalAudio': {'url': f'/api/audio/{job}/original.wav', 'tempo': 120, 'offsetSeconds': 0}}
    events = [{'program': 0, 'isDrum': False, 'start': i * .25, 'end': i * .25 + .1, 'midi': 60} for i in range(8)]
    for name, value in [('project.json', project), ('status.json', {'id': job, 'status': 'complete'}), ('multi-events.json', {'events': events}),
                        ('analysis-evidence.json', {'analyzedDurationSeconds': 2})]:
        (source / name).write_text(json.dumps(value))
    original = {path.name: path.read_bytes() for path in source.iterdir()}
    with TestClient(create_app(tmp_path)) as client:
        response = client.post(f'/api/projects/{job}/score-rhythm')
        assert response.status_code == 200, response.text
        result = response.json()
        assert result['id'] != job
        assert result['originalAudio']['url'] == project['originalAudio']['url']
        assert result['source']['analysis']['quality']['nativeEventsJobId'] == job
        audit = client.get(f'/api/projects/{result["id"]}/evidence').json()
        assert audit['modelRerun'] is False and audit['outputNotes'] == 8
        saved_job = client.get(f'/api/jobs/{result["id"]}').json()
        assert saved_job['project']['id'] == result['id']
        assert any(item['id'] == result['id'] for item in client.get('/api/projects').json()['projects'])
        assert client.post(f'/api/projects/{result["id"]}/score-rhythm').status_code == 404
    assert original == {path.name: path.read_bytes() for path in source.iterdir()}


def test_keyboard_hand_split_follows_register_without_changing_notes():
    # A low right-hand melody under a held left-hand bass stays in the right
    # hand: a fixed middle-C split would push G3/A3 into the bass staff.
    rows = [[0, 4, 36, .8], [0, 4, 43, .8]]
    rows += [[i * .5, i * .5 + .45, pitch, .8] for i, pitch in enumerate([67, 64, 59, 57, 59, 64, 67, 71])]
    notes, _ = rhythm(rows, program=0)
    assert len(notes) == len(rows)
    assert sorted((n['start'], n['midi']) for n in notes) == sorted((r[0] * 2, r[2]) for r in rows)
    assert all(n['staff'] == 2 for n in notes if n['midi'] < 48)
    assert all(n['staff'] == 1 for n in notes if n['midi'] >= 57)


def test_unordered_chord_spread_is_gathered_without_an_arpeggio_line():
    # Decoder jitter, not a sweep: attacks arrive out of pitch order.
    events = [[2 + d, 4., pitch, .8] for d, pitch in [(.04, 48), (0, 55), (.08, 60), (.02, 64)]]
    notes, audit = rhythm(events, program=0)
    assert len({n['start'] for n in notes}) == 1
    assert not any(n.get('arpeggio') for n in notes)
    assert any(c['reason'] == 'spread_chord_notation' for c in audit['boundaryChanges'])


def test_keyboard_hand_keeps_held_bass_and_two_written_voices():
    # Measured held bass (4 beats) under a moving inner line in the same hand.
    rows = [[0, 2, 40, .8], [0, .5, 52, .8], [.5, 1, 55, .8], [1, 1.5, 52, .8], [1.5, 2, 55, .8],
            [0, 1.9, 76, .8], [1, 1.9, 72, .8]]
    notes, audit = rhythm(rows, program=0)
    bass = next(n for n in notes if n['midi'] == 40)
    assert bass['duration'] == 4 and bass['staff'] == 2
    for staff in (1, 2):
        assert len({n['voice'] for n in notes if n['staff'] == staff}) <= 2
    assert len(notes) == len(rows)


def test_held_outer_note_ends_at_the_next_attack_in_its_register():
    # A long acoustic tail does not cross a new bass attack.
    rows = [[0, 3.9, 43, .8], [0, .4, 52, .8], [.5, .9, 52, .8], [1., 1.4, 52, .8], [1.5, 2., 38, .8]]
    notes, audit = rhythm(rows, program=0)
    bass = next(n for n in notes if n['midi'] == 43)
    assert bass['start'] + bass['duration'] == 3
    assert any(c['reason'] == 'keyboard_outer_voice_release' for c in audit['boundaryChanges'])
    assert len(notes) == len(rows)


def test_grace_like_attack_does_not_shrink_a_held_chord_tone_to_a_sliver():
    rows = [[0, 4, 50, .8], [0, 4, 57, .8], [.03, .15, 61, .8]]
    notes, _ = rhythm(rows, program=0)
    held = next(n for n in notes if n['midi'] == 57)
    assert held['duration'] >= 4

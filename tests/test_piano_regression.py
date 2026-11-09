import copy

import pytest

from server.score_rhythm import infer_notation_grid, infer_part_rhythm, keyboard_voices


def test_voice_layout_preserves_a_held_inner_note_without_detected_pedal():
    # A finger can hold C while other fingers move. Missing pedal detection
    # is not evidence that the key was released at the next bass attack.
    notes = [
        {'midi': 36, 'start': 0., 'duration': 1., 'staff': 2},
        {'midi': 48, 'start': 0., 'duration': 4., 'staff': 2},
        {'midi': 43, 'start': 1., 'duration': 1., 'staff': 2},
        {'midi': 40, 'start': 2., 'duration': 2., 'staff': 2},
    ]
    before = copy.deepcopy(notes)
    keyboard_voices(notes)
    assert [{k: n[k] for k in b} for n, b in zip(notes, before)] == before
    assert notes[0]['voice'] != notes[1]['voice']


def test_two_hands_can_roll_in_pitch_order_while_interleaving_each_other():
    # LH C E G B, RH E G C. Each hand rises; the hands interleave.
    rows = [[2 + delay, 4., midi, .8] for delay, midi in
            [(0, 36), (.04, 40), (.08, 43), (.12, 64), (.16, 47), (.20, 67), (.24, 72)]]
    notes, _ = infer_part_rhythm(rows, {'bpm': 60, 'offsetSeconds': 0}, 5, 'piano', program=0)
    assert all(n.get('arpeggio') for n in notes)
    assert [n['arpeggioOffset'] for n in notes] == pytest.approx([0, .04, .08, .12, .16, .20, .24])


def test_rolled_chords_do_not_double_the_global_notation_tempo():
    events = [{'start': bar * 4 + i * .05, 'end': bar * 4 + 3.,
               'midi': pitch, 'program': 0, 'isDrum': False}
              for bar in range(12) for i, pitch in enumerate([36, 43, 48, 55, 60, 64, 67])]
    assert infer_notation_grid(events, {'bpm': 65, 'offsetSeconds': 0})['bpm'] == 65


def test_rolled_inner_chord_tone_survives_a_following_melody_attack():
    rows = [[2 + delay, 4., midi, .8] for delay, midi in
            [(0, 48), (.03, 51), (.09, 54), (.15, 66), (.19, 58), (.21, 70)]]
    rows.append([2.5, 3., 77, .8])
    notes, _ = infer_part_rhythm(rows, {'bpm': 120, 'offsetSeconds': 0}, 5, 'piano', program=0)
    inner = next(n for n in notes if n['midi'] == 58)
    assert inner['start'] + inner['duration'] == 8
    assert inner.get('arpeggio')


def test_notation_grid_can_be_rebuilt_without_applying_phase_twice():
    events = [{'start': i * .25, 'end': i * .25 + .1, 'midi': 60,
               'program': program, 'isDrum': False} for program in (0, 24) for i in range(24)]
    first = infer_notation_grid(events, {'bpm': 120, 'offsetSeconds': .024})
    second = infer_notation_grid(events, first)
    assert second == first

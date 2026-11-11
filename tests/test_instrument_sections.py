from server.instrument_sections import consolidate_instruments, decoder_channel, written_program
from server.multi import parts_from_multi_events
from server.score_rhythm import infer_part_rhythm

GRID = {'bpm': 120, 'offsetSeconds': 0}


def note(program, midi, start, end=None, **extra):
    return {'program': program, 'midi': midi, 'start': start, 'end': end or start + .4, 'isDrum': False, **extra}


def test_ensemble_dominated_strings_become_one_ensemble_part_with_every_note():
    events = [note(48, 60 + i % 12, i * .5) for i in range(30)]
    events += [note(40, 76, 20 + i * .5) for i in range(5)] + [note(42, 48, 20 + i * .5) for i in range(5)]
    result, audit = consolidate_instruments(events)
    assert audit['strings']['mode'] == 'ensemble'
    assert {e['program'] for e in result} == {48} and len(result) == len(events)
    assert sum(e.get('decodedProgram') == 40 for e in result) == 5


def test_solo_dominated_ordered_strings_keep_at_most_three_sections():
    events = [note(40, 76, i * .5) for i in range(20)] + [note(41, 64, i * .5) for i in range(20)]
    events += [note(42, 48, i * .5) for i in range(15)] + [note(43, 36, 30)]
    events += [note(48, 75, 40), note(48, 50, 41)]
    result, audit = consolidate_instruments(events)
    assert audit['strings']['mode'] == 'sections'
    assert {e['program'] for e in result} == {40, 41, 42}
    assert next(e for e in result if e['midi'] == 36)['program'] == 42
    assert next(e for e in result if e['midi'] == 75)['program'] == 40
    assert written_program(43, audit) == 42 and written_program(48, audit) is None


def test_unordered_registers_fall_back_to_one_ensemble():
    events = [note(40, 48, i * .5) for i in range(20)] + [note(42, 76, i * .5) for i in range(20)]
    result, audit = consolidate_instruments(events)
    assert audit['strings']['mode'] == 'ensemble' and audit['strings']['registerOrdered'] is False


def test_isolated_class_folds_into_same_channel_host_and_merges_exact_duplicate():
    events = [note(48, 60 + i % 7, i * .5, decodedChannel=5) for i in range(40)]
    events += [note(46, 61, .51, .9, decodedChannel=5), note(46, 90, 50, decodedChannel=5)]
    result, audit = consolidate_instruments(events)
    fold = next(d for d in audit['isolatedClasses'] if d['program'] == 46)
    assert fold['action'] == 'fold' and fold['hostProgram'] == 48 and fold['reason'] == 'same_decoder_channel'
    assert audit['absorbedNotes'] == 1 and len(result) == len(events) - 1
    assert next(e for e in result if e['midi'] == 90)['foldedFrom'] == 46


def test_isolated_class_without_channel_or_unison_support_is_kept_unchanged():
    events = [note(0, 60 + i % 12, i * .5, sourceId='piano') for i in range(40)]
    events += [note(73, 84, 3.1, 3.3), note(73, 86, 9.1, 9.3)]
    result, audit = consolidate_instruments(events)
    assert next(d for d in audit['isolatedClasses'] if d['program'] == 73)['action'] == 'pending'
    assert [e for e in result if e['program'] == 73] == [e for e in events if e['program'] == 73]


def test_real_independent_classes_above_evidence_threshold_are_never_merged():
    events = [note(40, 76, i * .5) for i in range(20)] + [note(73, 79, i * .5) for i in range(20)]
    result, audit = consolidate_instruments(events)
    assert {e['program'] for e in result} == {40, 73} and audit['absorbedNotes'] == 0


def test_decoder_channel_table_matches_mc13_layout():
    assert decoder_channel(46) == decoder_channel(48) == 5
    assert decoder_channel(80) == 9 and decoder_channel(88) == 10 and decoder_channel(0, True) == 12


def test_bowed_part_is_one_staff_with_chords_and_one_held_voice():
    rows = [[0, 4, 48, 1.]]  # a held low note under a moving two-note line
    rows += [[i * .5, i * .5 + .45, 72, 1.] for i in range(8)] + [[i * .5, i * .5 + .45, 76, 1.] for i in range(8)]
    rows += [[1., 1.4, 72, 1.]]  # same-pitch duplicate at a written attack
    notes, audit = infer_part_rhythm(rows, GRID, 5, 's', program=48)
    assert {n['staff'] for n in notes} == {1} and {n['voice'] for n in notes} == {'1', '2'}
    assert audit['bowedDuplicatesMerged'] == 1 and len(notes) == len(rows) - 1
    held = [n for n in notes if n['voice'] == '2']
    assert len(held) == 1 and held[0]['midi'] == 48 and held[0]['duration'] == 8
    by_start = {}
    for n in notes:
        if n['voice'] == '1':
            by_start.setdefault(n['start'], set()).add(n['duration'])
    assert all(len(lengths) == 1 for lengths in by_start.values())


def test_readable_parts_declare_a_single_staff_for_bowed_strings():
    events = [note(48, 40 + i % 40, i * .25) for i in range(60)]
    parts, audit = parts_from_multi_events(events, GRID, 20, readable=True)
    strings = [p for p in parts if p['program'] == 48]
    assert len(strings) == 1 and strings[0]['staves'] == [{'number': 1, 'clef': strings[0]['clef']}]
    assert audit['instrumentSections']['strings']['mode'] == 'ensemble'
    exact, _ = parts_from_multi_events(events, GRID, 20)
    assert 'staves' not in exact[0]  # the bounded performance score is not rewritten

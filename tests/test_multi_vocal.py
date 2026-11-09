import copy

import pytest

from server.multi import parts_from_multi_events
from server.multi_vocal import replace_vocal_lead


GRID = {'bpm': 60, 'offsetSeconds': 0}
VERIFICATION = {'available': True, 'abstain': False, 'intervals': [{'comparedFrames': 50}]}


def _event(midi, source_id='vocals', program=100, start=0., end=1.):
    return {'midi': midi, 'start': start, 'end': end, 'program': program, 'isDrum': False,
            'sourceId': source_id, 'sourceLabel': source_id, 'evidenceOrigins': ['yourmt3_mix']}


def _run():
    return {'success': True, 'duration_seconds': 4., 'chunks': [
        {'core_left': 0, 'core_right': 32000, 'sample_rate': 16000, 'frames': 100},
        {'core_left': 32000, 'core_right': 64000, 'sample_rate': 16000, 'frames': 100},
    ], 'events': [
        {'source_start_seconds': .1, 'source_end_seconds': .7, 'midi_pitch': 50},
        {'source_start_seconds': .7, 'source_end_seconds': 1.2, 'midi_pitch': 64},
    ]}


def _replace(native, learned, verification=VERIFICATION):
    return replace_vocal_lead(native, learned, source_id='vocals', source_label='vocals',
                              duration=4., voice_verification=verification)


def test_full_lead_replaces_only_the_identified_source_and_uses_one_staff():
    native = [_event(72), _event(71, start=.1), _event(70, 'other-vocals'), _event(75, None),
              _event(67, program=101), _event(60, 'piano', program=0)]
    learned = _run()
    original = copy.deepcopy((native, learned))

    events, audit = _replace(native, learned)

    assert (native, learned) == original
    assert audit['status'] == 'replaced'
    assert audit['replacedNativeLeadEvents'] == 2
    assert audit['learnedLeadEvents'] == 2
    assert audit['claimsWholeSongPitchTruth'] is False
    assert all(e in events for e in native[2:])
    lead = [e for e in events if e['program'] == 100 and e['sourceId'] == 'vocals']
    assert [(e['midi'], e['start'], e['end']) for e in lead] == [(50, .1, .7), (64, .7, 1.2)]
    assert all('yourmt3_mix' not in e['evidenceOrigins'] for e in lead)

    parts, conversion = parts_from_multi_events(events, GRID, 4., readable=True)
    main = next(p for p in parts if p['role'] == 'lead' and p.get('sourceId') == 'vocals')
    other = next(p for p in parts if p['role'] == 'lead' and p.get('sourceId') == 'other-vocals')
    assert main['staves'] == [{'number': 1, 'clef': 'treble'}]
    assert [n['midi'] for n in main['notes']] == [50, 64]
    assert main['notes'][0]['start'] + main['notes'][0]['duration'] <= main['notes'][1]['start']
    from server.vocal_score import VERSION as VOCAL_SCORE_VERSION
    assert conversion['parts'][main['id']]['scoreRhythm']['version'] == VOCAL_SCORE_VERSION
    assert conversion['parts'][other['id']]['scoreRhythm']['version'] != 'vocal-score-joint-rhythm-4'


@pytest.mark.parametrize(('mutation', 'status'), [
    (lambda run: None, 'unavailable'),
    (lambda run: {**run, 'success': False}, 'failed'),
    (lambda run: {**run, 'events': []}, 'empty'),
    (lambda run: {**run, 'chunks': run['chunks'][1:]}, 'incomplete_coverage'),
    (lambda run: {**run, 'chunks': run['chunks'][:1]}, 'incomplete_coverage'),
    (lambda run: {**run, 'events': [run['events'][0], {**run['events'][1], 'source_start_seconds': .6}]},
     'invalid_lead_events'),
])
def test_unusable_run_keeps_the_original_events(mutation, status):
    native = [_event(72)]
    events, audit = _replace(native, mutation(_run()))
    assert events == native
    assert audit['status'] == status
    assert audit['replacedNativeLeadEvents'] == 0


def test_sampled_verifier_abstention_keeps_original_events():
    native = [_event(72)]
    events, audit = _replace(native, _run(), {**VERIFICATION, 'abstain': True})
    assert events == native
    assert audit['status'] == 'unverified'


def test_unidentified_lead_is_preserved_without_a_target():
    native = [_event(72, None)]
    events, audit = _replace(native, _run())
    assert events == native
    assert audit['status'] == 'no_native_lead_for_source'


def _island_case(tmp_path, *, pitches=(59.,), strength=.75, island_start=.91, island_end=1.03,
                 learned_end=1.01, next_start=1.2):
    import numpy as np
    times = np.arange(401) / 100
    frequency, activation = np.zeros(len(times)), np.zeros(len(times))
    main = (times >= .2) & (times < .7)
    island = (times >= island_start) & (times < island_end)
    frequency[main] = 440 * 2 ** ((66 - 69) / 12)
    frequency[island] = 440 * 2 ** ((np.resize(pitches, np.count_nonzero(island)) - 69) / 12)
    activation[main], activation[island] = .85, strength
    path = tmp_path / 'contour.npz'
    np.savez(path, time=times, f0=frequency, activation=activation)
    return path, [
        {'source_start_seconds': .2, 'source_end_seconds': learned_end, 'midi_pitch': 66},
        {'source_start_seconds': next_start, 'source_end_seconds': 1.7, 'midi_pitch': 64},
    ]


def test_separately_voiced_pitch_recovers_a_note_across_the_learned_tail(tmp_path):
    from server.multi_vocal import recover_voiced_islands
    contour, events = _island_case(tmp_path)

    result, audit = recover_voiced_islands(events, contour, duration=4.)

    assert [(e['midi_pitch'], e['source_start_seconds'], e['source_end_seconds']) for e in result] == [
        (66, .2, .73), (59, .91, 1.03), (64, 1.2, 1.7)]
    assert events[0]['source_end_seconds'] == 1.01
    assert audit['edits'][0]['sourceEvent'] == events[0]
    assert audit['edits'][0]['resultEvents'] == result[:2]
    assert audit['claimsPitchTruth'] is False


@pytest.mark.parametrize('overrides', [
    {'pitches': (66.,)},
    {'pitches': (58.3, 59.7)},
    {'pitches': (65.9, 66.1, 66.7, 65.6)},
    {'strength': .15},
    {'island_start': .82},
    {'island_end': .99},
    {'learned_end': .9},
])
def test_dropout_unstable_weak_short_and_unowned_islands_are_not_split(tmp_path, overrides):
    from server.multi_vocal import recover_voiced_islands
    contour, events = _island_case(tmp_path, **overrides)

    result, audit = recover_voiced_islands(events, contour, duration=4.)

    assert result == events
    assert audit['edits'] == []


@pytest.mark.parametrize(('next_start', 'expected_end'), [(1.02, 1.02), (1.2, 1.04)])
def test_voiced_tail_stops_at_the_next_event_or_thirty_milliseconds(tmp_path, next_start, expected_end):
    from server.multi_vocal import recover_voiced_islands
    contour, events = _island_case(tmp_path, island_end=1.08, next_start=next_start)

    result, audit = recover_voiced_islands(events, contour, duration=4.)

    assert [e['midi_pitch'] for e in result] == [66, 59, 64]
    assert result[1]['source_end_seconds'] == expected_end <= result[2]['source_start_seconds']
    assert len(audit['edits']) == 1


def _consensus_fixture(*, crepe_pitches=(66.,), fcpe_pitches=None, native_pitch=69, coverage_end=1.4):
    import numpy as np
    times = np.arange(0, coverage_end, .02)
    match = (times >= .48) & (times < .68)
    def frequency(pitches):
        midi = np.full(len(times), 66.)
        midi[match] = np.resize(pitches, np.count_nonzero(match))
        return 440 * 2 ** ((midi - 69) / 12)
    contour = {'time': times, 'crepeF0': frequency(crepe_pitches),
               'fcpeF0': frequency(fcpe_pitches if fcpe_pitches is not None else crepe_pitches),
               'periodicity': np.full(len(times), .9), 'fcpeActivation': np.full(len(times), .9)}
    learned = [{'source_start_seconds': .2, 'source_end_seconds': 1.2, 'midi_pitch': 66}]
    native = [{'start': .46, 'end': .71, 'midi': native_pitch}]
    return learned, native, contour


def test_joint_stable_native_pitch_splits_only_its_learned_owner():
    from server.multi_vocal import adjudicate_vocal_consensus

    learned, native, contour = _consensus_fixture(crepe_pitches=(69.,))
    result, audit = adjudicate_vocal_consensus(learned, native, contour)
    assert [(n['midi_pitch'], n['source_start_seconds'], n['source_end_seconds']) for n in result] == [
        (66, .2, .48), (69, .48, .68), (66, .68, 1.2)]
    assert audit['edits'][0]['sourceEvent'] == learned[0]
    assert audit['edits'][0]['resultEvents'] == result
    assert audit['claimsPitchTruth'] is False


@pytest.mark.parametrize('overrides', [
    {'crepe_pitches': (66., 69.)},
    {'crepe_pitches': (69.,), 'fcpe_pitches': (66.,)},
    {'crepe_pitches': (69.,), 'coverage_end': .65},
    {'crepe_pitches': (66.,), 'native_pitch': 78},
    {'crepe_pitches': (66.,), 'native_pitch': 66},
])
def test_consensus_does_not_guess_vibrato_unsupported_octaves_same_pitch_or_partial_coverage(overrides):
    from server.multi_vocal import adjudicate_vocal_consensus

    learned, native, contour = _consensus_fixture(**overrides)
    result, audit = adjudicate_vocal_consensus(learned, native, contour)
    assert result == learned
    assert audit['edits'] == []


def test_consensus_leaves_existing_same_pitch_reattacks_intact():
    from server.multi_vocal import adjudicate_vocal_consensus

    learned, native, contour = _consensus_fixture(native_pitch=66)
    learned = [dict(learned[0], source_end_seconds=.60), dict(learned[0], source_start_seconds=.60)]
    result, audit = adjudicate_vocal_consensus(learned, native, contour)
    assert result == learned
    assert audit['edits'] == []


def test_consensus_plan_is_bounded_and_prioritizes_octave_disputes():
    import numpy as np
    from server.multi_vocal import vocal_consensus_windows

    times = np.arange(0, 150, .01)
    learned = [{'source_start_seconds': float(t), 'source_end_seconds': t + .5, 'midi_pitch': 60}
               for t in range(2, 150, 2)]
    native = [{'start': n['source_start_seconds'], 'end': n['source_end_seconds'], 'midi': 72}
              for n in learned]
    hz = np.full(len(times), 440 * 2 ** ((60 - 69) / 12))
    windows = vocal_consensus_windows(learned, native, times, hz, np.full(len(times), .9), 150.)
    assert windows
    assert sum(end - start for start, end in windows) <= 60
    assert all(left[1] < right[0] for left, right in zip(windows, windows[1:]))


def test_secondary_octave_overlap_is_audited_without_rewriting_a_matching_pitch():
    from server.multi_vocal import adjudicate_vocal_consensus

    learned, native, contour = _consensus_fixture(native_pitch=78)
    learned = [dict(learned[0], source_end_seconds=.58, midi_pitch=78),
               dict(learned[0], source_start_seconds=.58)]
    result, audit = adjudicate_vocal_consensus(learned, native, contour)
    assert result == learned
    assert len(audit['octaveDisagreements']) == 1
    assert audit['octaveDisagreements'][0]['applied'] is False


def test_consensus_abstains_when_only_the_competing_pitch_has_local_coverage():
    from server.multi_vocal import adjudicate_vocal_consensus

    learned, native, contour = _consensus_fixture(crepe_pitches=(69.,), coverage_end=.8)
    result, audit = adjudicate_vocal_consensus(learned, native, contour)
    assert result == learned
    assert audit['abstentions'][0]['reason'] == 'incomplete_learned_event_coverage'


def test_consensus_does_not_fill_a_voiced_residual_with_unsupported_old_pitch():
    from server.multi_vocal import adjudicate_vocal_consensus

    learned, native, contour = _consensus_fixture(crepe_pitches=(69.,))
    residual = contour['time'] >= .68
    for key in ('crepeF0', 'fcpeF0'):
        contour[key][residual] = 440 * 2 ** ((72 - 69) / 12)
    result, audit = adjudicate_vocal_consensus(learned, native, contour)
    assert result == learned
    assert audit['abstentions'][0]['reason'] == 'voiced_residual_without_supported_pitch'


def test_consensus_leaves_unvoiced_residual_as_rest():
    from server.multi_vocal import adjudicate_vocal_consensus

    learned, native, contour = _consensus_fixture(crepe_pitches=(69.,))
    residual = contour['time'] >= .68
    contour['periodicity'][residual] = .05
    contour['fcpeActivation'][residual] = .01
    result, audit = adjudicate_vocal_consensus(learned, native, contour)
    assert [(n['midi_pitch'], n['source_end_seconds']) for n in result] == [(66, .48), (69, .68)]
    assert len(audit['edits']) == 1


def test_consensus_abstains_on_semitone_return_without_a_reattack_measure():
    from server.multi_vocal import adjudicate_vocal_consensus

    learned, native, contour = _consensus_fixture(crepe_pitches=(67.,), native_pitch=67)
    result, audit = adjudicate_vocal_consensus(learned, native, contour)
    assert result == learned
    assert audit['abstentions'][0]['reason'] == 'semitone_neighbor_return'


def test_consensus_does_not_create_a_short_neighbor_return_across_phoneme_boundaries():
    from server.multi_vocal import adjudicate_vocal_consensus
    learned,native,contour=_consensus_fixture(crepe_pitches=(64.,),native_pitch=64)
    parent=learned[0]
    previous=dict(parent,source_start_seconds=.2,source_end_seconds=.48)
    parent=dict(parent,source_start_seconds=.48)
    result,audit=adjudicate_vocal_consensus([previous,parent],native,contour)
    assert result==[previous,parent]
    assert audit['abstentions'][0]['reason']=='cross_boundary_neighbor_return'

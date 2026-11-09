import copy
import numpy as np

from server.vocal_phrase import recover_articulation_gaps


def fixture(*, silence=False, repeated=False, third_pitch=False):
    times = np.arange(201) / 100
    f0 = np.zeros(len(times))
    activation = np.zeros(len(times))
    rms = np.full(len(times), .025)
    events = [dict(source_start_seconds=.2, source_end_seconds=.32, midi_pitch=59),
              dict(source_start_seconds=.74, source_end_seconds=1.5, midi_pitch=59 if repeated else 64)]
    for note in events:
        mask = (times >= note['source_start_seconds']) & (times < note['source_end_seconds'])
        f0[mask] = 440 * 2 ** ((note['midi_pitch'] - 69) / 12)
        activation[mask] = .85
    if silence:
        rms[(times >= .34) & (times < .64)] = .001
    if third_pitch:
        mask = (times >= .4) & (times < .6)
        f0[mask] = 440 * 2 ** ((62 - 69) / 12)
        activation[mask] = .85
    return events, times, f0, activation, rms


def test_short_syllable_body_does_not_notate_consonants_as_a_rest():
    args = fixture()
    original = copy.deepcopy(args[0])
    events, audit = recover_articulation_gaps(*args)
    assert events[0]['notation_end_seconds'] == .74
    assert events[0]['source_end_seconds'] == .32
    assert args[0] == original
    assert len(audit['edits']) == 1


def test_true_breath_repeated_syllable_and_third_pitch_are_preserved():
    for kwargs in ({'silence': True}, {'repeated': True}, {'third_pitch': True}):
        args = fixture(**kwargs)
        events, audit = recover_articulation_gaps(*args)
        assert events == args[0]
        assert audit['edits'] == []


def test_unmeasured_gap_and_long_rest_are_not_filled():
    args = list(fixture())
    for change in ('coverage', 'long'):
        values = copy.deepcopy(args)
        if change == 'coverage':
            keep = (values[1] < .4) | (values[1] > .6)
            values[1:] = [a[keep] for a in values[1:]]
        else:
            values[0][1]['source_start_seconds'] = 1.0
        events, audit = recover_articulation_gaps(*values)
        assert events == values[0]
        assert audit['edits'] == []


def test_phrase_annotation_reaches_formal_score_and_playback_duration():
    from server.multi_vocal import replace_vocal_lead
    from server.multi import parts_from_multi_events
    events, _ = recover_articulation_gaps(*fixture())
    learned = dict(success=True, events=events, duration_seconds=2.,
                   chunks=[dict(core_left=0, core_right=200, frames=200, sample_rate=100)])
    native = [dict(start=.2, end=.32, midi=59, program=100, isDrum=False, sourceId='vocals')]
    replaced, _ = replace_vocal_lead(native, learned, source_id='vocals', source_label='voice', duration=2.,
                                     voice_verification=dict(available=True, abstain=False, intervals=[{}]))
    assert replaced[0]['end'] == .74
    assert replaced[0]['acousticEnd'] == .32
    parts, _ = parts_from_multi_events(replaced, dict(bpm=60, offsetSeconds=.2), 2., readable=True)
    notes = parts[0]['notes']
    assert notes[0]['duration'] >= .5
    assert notes[0]['start'] + notes[0]['duration'] == notes[1]['start']

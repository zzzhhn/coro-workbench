import numpy as np

from server.singing_pipeline import build_singing_notes


def signals():
    return dict(attack=lambda _:True, structural_attack=lambda _:True,
                pitch_support=lambda *_:0., onset_pitch_spread=lambda *_:None,
                pitch_runs=lambda *_:[], contour_pitch=lambda *_:None,
                short_contour_support=lambda *_:0.)


def test_partial_lyrics_do_not_disable_timing_for_uncovered_phrases():
    events=[dict(id=str(i), start=i*.5+.06, end=i*.5+.46, midi=60) for i in range(30)]
    events[0]['start']=.19
    words=[dict(id='word', start=12.95, vowelStart=13.06, end=13.46, text='甲')]
    grid=dict(bpm=60, offsetSeconds=0.)
    # A genuine breath isolates the later lyric-covered phrase.
    events=events[:24]+events[26:]
    plain,_=build_singing_notes(events, [], grid, 'C', signals())
    partial,audit=build_singing_notes(events, words, grid, 'C', signals())
    assert partial[:24] == plain[:24]
    assert audit['vocalPhase']['applied']
    assert any(n.get('lyric')=='甲' for n in partial)


def test_timing_audit_describes_the_notes_actually_played_after_phase_correction():
    events=[dict(id=str(i), start=i*.25+.06, end=i*.25+.24, midi=60) for i in range(40)]
    grid=dict(bpm=60, offsetSeconds=0.)
    notes,audit=build_singing_notes(events, [], grid, 'C', signals())
    assert audit['vocalPhase']['applied']
    for note,row in zip(notes,audit['timing']):
        assert np.isclose(note['start'], row['scoreStartSeconds'])
        assert np.isclose(note['start']+note['duration'], row['scoreEndSeconds'])
        assert row['sourceStartSeconds'] == next(e['start'] for e in events if e['id']==note['id'])

from pathlib import Path

import pretty_midi

from server import score_eval


def _midi(path: Path):
    midi = pretty_midi.PrettyMIDI(initial_tempo=60)
    lead = pretty_midi.Instrument(0)
    # Bar 1 (beats 0-4 of the reference): C4 C4 (a re-attack), dotted D4, E4.
    for start, end, pitch in ((0, .5, 60), (.5, 1, 60), (1, 2.5, 62), (2.5, 3, 64)):
        lead.notes.append(pretty_midi.Note(80, pitch, start, end))
    piano = pretty_midi.Instrument(0)
    piano.notes.append(pretty_midi.Note(80, 36, 0, 4))      # sustained bass, 4 beats
    piano.notes.append(pretty_midi.Note(80, 67, 1, 1.5))
    midi.instruments += [lead, piano]
    midi.write(str(path))


def test_reference_is_aligned_by_one_explicit_beat_offset(tmp_path):
    _midi(tmp_path / 'ref.mid')
    ref = score_eval.load_reference_midi(tmp_path / 'ref.mid', {'lead': [0], 'piano': [1]}, first_bar_beat=4)
    assert [n['start'] for n in ref.notes['lead']] == [4, 4.5, 5, 6.5]
    assert ref.bar_range(1, 1) == (4, 8)


def test_lead_metrics_count_reattacks_dots_and_octaves(tmp_path):
    _midi(tmp_path / 'ref.mid')
    ref = score_eval.load_reference_midi(tmp_path / 'ref.mid', {'lead': [0], 'piano': [1]}, first_bar_beat=4)
    merged = {'parts': [{'id': 'lead', 'role': 'lead', 'notes': [
        {'start': 4, 'duration': 1, 'midi': 60},          # the re-attack was merged
        {'start': 5, 'duration': 1.5, 'midi': 62},        # dotted, matches the reference
        {'start': 6.5, 'duration': .5, 'midi': 52}]}]}    # octave error
    report = score_eval.evaluate({'merged': merged}, ref, [(1, 1)])
    lead = report['candidates']['merged']['lead']['1-1']
    assert (lead['ref'], lead['est'], lead['exact']) == (4, 3, 2)
    assert lead['octaveOnly'] == 1
    assert (lead['refReattacks'], lead['reattacksFound']) == (1, 0)
    assert (lead['dotted'], lead['refDotted']) == (1, 1)


def test_piano_metrics_report_sustained_bass_coverage(tmp_path):
    _midi(tmp_path / 'ref.mid')
    ref = score_eval.load_reference_midi(tmp_path / 'ref.mid', {'piano': [1]}, first_bar_beat=4)
    fragmented = {'parts': [{'id': 'piano-0', 'role': 'instrument', 'notes': [
        {'start': 4, 'duration': .5, 'midi': 36, 'arpeggio': True},
        {'start': 5, 'duration': .5, 'midi': 67}]}]}
    sustained = {'parts': [{'id': 'piano-0', 'role': 'instrument', 'notes': [
        {'start': 4, 'duration': 4, 'midi': 36}, {'start': 5, 'duration': .5, 'midi': 67}]}]}
    report = score_eval.evaluate({'a': fragmented, 'b': sustained}, ref, [(1, 1)])
    a = report['candidates']['a']['piano']['1-1']
    b = report['candidates']['b']['piano']['1-1']
    assert (a['refSustainedBass'], a['sustainedBassCovered'], a['estSubBeatLow'], a['arpeggioMarks']) == (1, 0, 1, 1)
    assert (b['sustainedBassCovered'], b['estSubBeatLow'], b['arpeggioMarks']) == (1, 0, 0)
    assert a['exact'] == b['exact'] == 2

import pytest

from server.audio_harmony import score_chords


def segment(start, end, symbol="C", pitches=None, bass=0):
    return {"sourceStartSeconds": start, "sourceEndSeconds": end, "symbol": symbol,
            "pitches": pitches if pitches is not None else [48, 52, 55], "bassPitchClass": bass}


def test_maps_source_seconds_without_carrying_chords_through_no_chord():
    source = {"segments": [segment(0, 1), segment(1, 2, "N", [], None), segment(2, 3)]}
    chords, metrics = score_chords(source, 120, -.5, 8)
    assert [(item["start"], item["duration"]) for item in chords] == [(1, 2), (5, 2)]
    assert metrics["noChordSeconds"] == 1
    assert not any("confidence" in chord for chord in chords)


def test_extends_pitch_pool_with_explicit_nonchord_slash_bass():
    chords, _ = score_chords({"segments": [segment(0, 2, "C/Bb", bass=10)]}, 120, 0, 8)
    assert 10 in {pitch % 12 for pitch in chords[0]["pitches"]}
    assert chords[0]["symbol"] == "C/Bb"


def test_coalesces_same_chord_only_when_contiguous_and_preserves_short_event_evidence():
    report = {"segments": [segment(0, 1), segment(1, 2), segment(2, 2.01, "G", [55, 59, 62], 7)]}
    chords, details = score_chords(report, 120, 0, 8)
    assert len(chords) == 1 and chords[0]["duration"] == 4
    assert details["shortSegmentsCollapsedByGrid"] == 1
    assert len(report["segments"]) == 3


def test_all_no_chord_is_empty_harmony_not_a_fake_triad():
    chords, _ = score_chords({"segments": [segment(0, 2, "N", [], None)]}, 120, 0, 8)
    assert chords == []


def test_rejects_overlaps_bad_intervals_and_invalid_pitches():
    for segments in ([segment(0, 2), segment(1, 3)], [segment(1, 0)], [segment(0, 2, pitches=[999])]):
        with pytest.raises(ValueError):
            score_chords({"segments": segments}, 120, 0, 8)

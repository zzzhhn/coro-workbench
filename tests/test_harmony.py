from __future__ import annotations

import numpy as np
import pytest

from server.harmony import chord_candidates, extract_acoustic_features


@pytest.mark.parametrize("symbol,pitches,root", [
    ("C", [0, 4, 7], 0), ("Am", [9, 0, 4], 9), ("G7", [7, 11, 2, 5], 7),
    ("Dmaj7", [2, 6, 9, 1], 2), ("Em7", [4, 7, 11, 2], 4),
    ("Fsus2", [5, 7, 0], 5), ("Bsus4", [11, 4, 6], 11),
    ("Cdim", [0, 3, 6], 0), ("Bdim7", [11, 2, 5, 8], 11),
    ("Dm7b5", [2, 5, 8, 0], 2), ("Caug", [0, 4, 8], 0),
])
def test_known_chord_templates_without_score_key(symbol, pitches, root):
    chroma = np.zeros(12)
    chroma[pitches] = 1
    bass = np.zeros(12)
    bass[root] = 1
    result = chord_candidates(chroma, bass)
    assert result[0]["symbol"] == symbol
    assert set(result[0]["pitchClasses"]) == set(pitches)


def test_inverted_major_stays_major_without_forcing_bass_root():
    chroma = np.zeros(12)
    chroma[[0, 4, 7]] = 1
    bass = np.zeros(12)
    bass[4] = 1
    assert chord_candidates(chroma, bass)[0]["symbol"] == "C"


def test_ambiguous_relative_and_suspended_pitches_keep_alternatives():
    chroma = np.zeros(12)
    chroma[[0, 4, 7, 9]] = 1
    results = chord_candidates(chroma, np.zeros(12))
    assert {results[0]["symbol"], results[1]["symbol"]} == {"C6", "Am7"}
    assert results[0]["score"] == results[1]["score"]


def test_silence_returns_no_chord():
    assert chord_candidates(np.zeros(12))[0]["symbol"] == "N"


def test_vocal_input_is_rejected_not_accidentally_used(tmp_path):
    with pytest.raises(ValueError, match="exclude"):
        extract_acoustic_features({"vocals": tmp_path / "voice.wav"})


def test_invalid_chroma_is_rejected():
    with pytest.raises(ValueError):
        chord_candidates(np.ones(13))
    with pytest.raises(ValueError):
        chord_candidates(np.array([float("nan")] * 12))


def test_audio_silence_noise_and_clipped_source_mapping(tmp_path):
    """Exercise actual audio + extraction, with independently authored sine tones."""
    import soundfile as sf
    from server.harmony import infer_audio_harmony

    sr = 22050
    time = np.arange(sr * 4) / sr
    # C3/E3/G3, then silence, then broadband noise: no production templates used.
    wave = sum(.12 * np.sin(2 * np.pi * hz * time) for hz in (130.81278265, 164.81377846, 195.99771799))
    wave[sr:sr * 2] = 0
    wave[sr * 2:sr * 3] = np.random.default_rng(2701).normal(0, .05, sr)
    sf.write(tmp_path / 'accompaniment.wav', wave, sr, subtype='FLOAT')
    features = extract_acoustic_features({'piano': tmp_path / 'accompaniment.wav'}, .17, 3.93, tmp_path / 'evidence')
    result = infer_audio_harmony(features, bpm=120, offset_seconds=-.13, beats_per_window=1)
    assert result['requiresExplicitApply'] is True
    assert result['usesDecodedNotes'] is False and result['usesScoreKey'] is False
    assert result['segments'][0]['start'] == pytest.approx(.6)
    for segment in result['segments']:
        assert -.13 + segment['start'] * .5 == pytest.approx(segment['sourceStartSeconds'], abs=1e-6)
        assert -.13 + (segment['start'] + segment['duration']) * .5 == pytest.approx(segment['sourceEndSeconds'], abs=1e-6)
        assert .17 <= segment['sourceStartSeconds'] < segment['sourceEndSeconds'] <= 3.93
    stable = [s for s in result['segments'] if s['sourceStartSeconds'] >= .2 and s['sourceEndSeconds'] < .99]
    assert stable and all(s['symbol'] == 'C' for s in stable)
    silence = [s for s in result['segments'] if s['sourceStartSeconds'] >= 1.1 and s['sourceEndSeconds'] < 1.99]
    noise = [s for s in result['segments'] if s['sourceStartSeconds'] >= 2.1 and s['sourceEndSeconds'] < 2.99]
    assert silence and noise and all(s['symbol'] == 'N' for s in silence + noise)
    assert (tmp_path / 'evidence/features.npz').is_file()
    assert result['provenance']['sourceStems'][0]['stem'] == 'piano'


@pytest.mark.parametrize('start,end', [(-1, 2), (1, .5), (float('nan'), 2), (0, float('inf'))])
def test_invalid_audio_slice_rejected_before_read(tmp_path, start, end):
    with pytest.raises(ValueError, match='finite'):
        extract_acoustic_features({'piano': tmp_path / 'unused.wav'}, start, end)


def test_grid_requires_finite_offset():
    from server.harmony import infer_audio_harmony
    with pytest.raises(ValueError):
        infer_audio_harmony(None, 120, float('nan'))

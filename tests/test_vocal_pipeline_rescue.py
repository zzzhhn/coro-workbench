"""Exercise the normal import orchestration when its first model misses vocals."""
import json
import sys
import types

import numpy as np
import pytest
import soundfile as sf

from server import audio_quality, config, pipeline


@pytest.mark.parametrize('rescued', [True, False])
def test_empty_basic_pitch_allows_learned_vocal_attempt(tmp_path, monkeypatch, rescued):
    audio = .1 * np.sin(2 * np.pi * 220 * np.arange(22050) / 22050)
    for filename in ('analysis.wav', 'stem-vocals.wav'):
        sf.write(tmp_path / filename, audio, 22050)
    monkeypatch.setattr(pipeline, 'decode_audio', lambda *args: (1., 1.))
    monkeypatch.setattr(pipeline, 'detect_tempo_and_key', lambda *args: (120., 'C', []))
    monkeypatch.setattr(config, 'engine_health', lambda: {'instrumentClassifier': {'ready': False}})
    monkeypatch.setattr(config, 'basic_pitch_path', lambda: None)
    monkeypatch.setattr(pipeline, 'separate_sources', lambda *args: {'vocals': tmp_path / 'stem-vocals.wav'})
    monkeypatch.setattr(pipeline, 'transcribe', lambda *args: ([], []))
    # A model-free orchestration test: do not require ONNX/Torch in CI.
    inference = types.ModuleType('basic_pitch.inference')
    inference.Model = lambda *args: None
    monkeypatch.setitem(sys.modules, 'basic_pitch.inference', inference)
    monkeypatch.setattr(audio_quality, 'quality_engine_ready', lambda: True)
    attempted = []

    def improve(directory, source, request, paths, raw_events, status):
        attempted.append(True)
        assert source['parts'] == []
        assert 'vocals' in paths
        if rescued:
            source['parts'] = [{'id': 'vocals', 'notes': [
                {'id': 'v1', 'midi': 57, 'start': 0, 'duration': 1, 'velocity': .8},
            ]}]
        return source

    monkeypatch.setattr(audio_quality, 'improve_project', improve)

    class Status:
        def update(self, *args):
            pass

        def check_cancelled(self):
            pass

    request = {'id': 'a' * 32, 'input': 'source.wav', 'filename': 'test.wav',
               'tempo': None, 'max_seconds': 60, 'mode': 'separate', 'decoder': 'rosvot'}
    if rescued:
        result = pipeline.analyze_audio(tmp_path, request, Status())
        assert result['parts'][0]['notes'][0]['midi'] == 57
        assert json.loads((tmp_path / 'raw-project.json').read_text())['parts'] == []
    else:
        with pytest.raises(ValueError, match='均未检出'):
            pipeline.analyze_audio(tmp_path, request, Status())
        assert not (tmp_path / 'project.json').exists()
    assert attempted == [True]

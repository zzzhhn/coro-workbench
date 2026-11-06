from pathlib import Path
import copy

import numpy as np
import pytest
import soundfile as sf

from server.vocal_input import materialize_input, resolve_input
from server.storage import Cancelled


@pytest.fixture
def source(tmp_path):
    directory = tmp_path / ('a' * 32)
    directory.mkdir()
    for name in ('stem-lead.wav', 'stem-vocals.wav', 'analysis.wav'):
        sf.write(directory / name, np.ones((16000, 2), np.float32) * .01, 16000, subtype='FLOAT')
    return tmp_path, {'originalAudio': {'url': f'/api/audio/{directory.name}/original.wav'}}, directory / 'stem-lead.wav'


class Status:
    def __init__(self): self.stages = []
    def update(self, progress, stage, message): self.stages.append((progress, stage))
    def check_cancelled(self): pass


def test_saved_source_choice_uses_authoritative_original_directory(source):
    root, stored, current = source
    assert resolve_input(root, stored, current, 'current') == current
    assert resolve_input(root, stored, current, 'original-vocals') == current.parent / 'stem-vocals.wav'
    assert resolve_input(root, stored, current, 'enhanced-vocals') == current.parent / 'analysis.wav'
    with pytest.raises(ValueError): resolve_input(root, stored, current, '../../outside.wav')


def test_source_duration_mismatch_and_symlink_are_not_guessed(source):
    root, stored, current = source
    vocals = current.parent / 'stem-vocals.wav'
    sf.write(vocals, np.zeros((4000, 2)), 16000)
    with pytest.raises(ValueError, match='长度不一致'): resolve_input(root, stored, current, 'original-vocals')
    vocals.unlink()
    vocals.symlink_to(current)
    with pytest.raises(ValueError, match='符号链接'): resolve_input(root, stored, current, 'original-vocals')


def test_enhanced_full_vocals_are_saved_separately_and_receive_new_pitch_extraction(source, monkeypatch):
    import server.melband as melband
    import server.vocal_input as module
    root, stored, current = source
    target = root / ('b' * 32)
    target.mkdir()
    before = current.read_bytes()
    def separate(path, output, **kwargs):
        assert path == current.parent / 'analysis.wav'
        kwargs['cancel_check']()
        output.mkdir()
        sf.write(output / 'vocals.wav', np.ones((16000, 2), np.float32) * 1.2, 16000, subtype='FLOAT')
        return {'vocalsPath': str(output / 'vocals.wav')}
    monkeypatch.setattr(melband, 'separate_vocals', separate)
    extracted = []
    monkeypatch.setattr(module, 'extract_selected_contour', lambda path, status: (extracted.append(path), {'available': True}))
    selected, report = materialize_input(target, stored, current, 'enhanced-vocals', Status())
    assert selected == target / 'stem-vocals.wav' and extracted == [selected]
    assert np.max(sf.read(selected)[0]) > 1.
    assert current.read_bytes() == before and report['inputChanged'] is True


def test_current_input_does_not_run_a_separator_or_regenerate_pitch(source, monkeypatch):
    import server.melband as melband
    root, stored, current = source
    monkeypatch.setattr(melband, 'separate_vocals', lambda *a, **k: pytest.fail('should not separate'))
    selected, report = materialize_input(root / 'not-created', stored, current, 'current', Status())
    assert selected == current and report['inputChanged'] is False


def test_cancel_during_enhancement_propagates_without_fallback(source, monkeypatch):
    import server.melband as melband
    root, stored, current = source
    def cancel(*args, **kwargs): raise Cancelled()
    monkeypatch.setattr(melband, 'separate_vocals', cancel)
    with pytest.raises(Cancelled): materialize_input(root / 'output', stored, current, 'enhanced-vocals', Status())


def test_cancel_reaps_the_fresh_pitch_extraction_child(source, monkeypatch):
    import server.vocal_input as module
    root, stored, current = source
    models = root / 'models'
    python = models / 'audio-quality/.venv/bin/python'
    python.parent.mkdir(parents=True)
    python.touch()
    monkeypatch.setattr(module.config, 'MODELS_DIR', models)
    class Child:
        returncode = None
        stopped = False
        def poll(self): return self.returncode
        def terminate(self): self.stopped = True; self.returncode = -15
        def wait(self, timeout=None): return self.returncode
    child = Child()
    monkeypatch.setattr(module.subprocess, 'Popen', lambda *args, **kwargs: child)
    class CancelStatus(Status):
        def check_cancelled(self): raise Cancelled()
    with pytest.raises(Cancelled): module.extract_selected_contour(current, CancelStatus())
    assert child.stopped

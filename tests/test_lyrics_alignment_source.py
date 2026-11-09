"""SOFA source pinning works for release archives (no .git) and rejects edits."""
import hashlib
import subprocess

import pytest

from server import lyrics_alignment
from server.lyrics_alignment import SOFA_COMMIT, source_revision


def fake_release(tmp_path, monkeypatch):
    files = {}
    for name in lyrics_alignment.SOFA_FILES:
        path = tmp_path/name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f'owned fixture for {name}\n')
        files[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    monkeypatch.setattr(lyrics_alignment, 'SOFA_FILES', files)
    return tmp_path


def test_release_archive_without_git_is_verified_by_content(tmp_path, monkeypatch):
    source = fake_release(tmp_path, monkeypatch)
    assert not (source/'.git').exists()
    assert source_revision(source) == SOFA_COMMIT


def test_modified_or_missing_file_is_rejected(tmp_path, monkeypatch):
    source = fake_release(tmp_path, monkeypatch)
    (source/'onnx_infer.py').write_text('changed\n')
    with pytest.raises(ValueError, match='onnx_infer.py'):
        source_revision(source)
    (source/'onnx_infer.py').unlink()
    with pytest.raises(ValueError, match='onnx_infer.py'):
        source_revision(source)


def test_git_checkout_at_another_revision_is_rejected(tmp_path, monkeypatch):
    source = fake_release(tmp_path, monkeypatch)
    def other(*args, **kwargs):
        return subprocess.CompletedProcess(args, 0, stdout='0'*40+'\n', stderr='')
    monkeypatch.setattr(lyrics_alignment.subprocess, 'run', other)
    with pytest.raises(ValueError, match='revision changed'):
        source_revision(source)

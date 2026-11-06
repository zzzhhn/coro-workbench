from __future__ import annotations

import hashlib
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from server.app import create_app
from server.pitch_evidence import read_pitch_window, read_pitch_coverage
from server.storage import atomic_json


@pytest.fixture
def pitch_job(tmp_path):
    directory = tmp_path / ("a" * 32)
    audit_dir = directory / "dense-voice-audit"
    audit_dir.mkdir(parents=True)
    path = audit_dir / "contours.npz"
    np.savez_compressed(path, time=np.arange(100) * .02, fcpeF0=np.full(100, 440.),
                        crepeF0=np.full(100, 880.), periodicity=np.r_[np.zeros(10), np.ones(90)],
                        activation=np.ones(100), audible=np.r_[np.zeros(5, dtype=bool), np.ones(95, dtype=bool)],
                        jointVoiced=np.ones(100, dtype=bool))
    atomic_json(directory / "quality-evidence.json", {"denseVoiceAudit": {"durationSeconds": 2, "contourFile": str(path)}})
    atomic_json(directory / "status.json", {"id": directory.name, "status": "complete", "project": {}})
    return directory, path


def test_returns_real_pitch_and_preserves_unvoiced_gaps(pitch_job):
    directory, path = pitch_job
    before = path.read_bytes()
    result = read_pitch_window(directory, 0, .4)
    assert len(result["frames"]) == 21
    assert result["frames"][0]["fcpeMidi"] is None
    assert result["frames"][5]["fcpeMidi"] == 69
    assert result["frames"][5]["crepeMidi"] is None
    assert result["frames"][10]["crepeMidi"] == 81
    assert result["groundTruthAvailable"] is False
    assert result["frameStepSeconds"] == .02
    assert path.read_bytes() == before
    assert str(directory) not in str(result)


@pytest.mark.parametrize("start,end", [(-1, 1), (0, 25), (1, 1), (float("nan"), 2), (0, float("inf")), (3, 4)])
def test_rejects_invalid_or_unbounded_windows(pitch_job, start, end):
    with pytest.raises(ValueError):
        read_pitch_window(pitch_job[0], start, end)


def test_verifies_known_cache_hash_and_rejects_corruption(pitch_job):
    directory, path = pitch_job
    atomic_json(path.parent / "cache.json", {"contourSha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    assert read_pitch_window(directory, 0, 2)["integrity"] == "sha256_checked"
    path.write_bytes(path.read_bytes() + b"corruption")
    with pytest.raises(ValueError, match="哈希"):
        read_pitch_window(directory, 0, 2)


def test_rejects_foreign_job_path_and_symlink(pitch_job, tmp_path):
    directory, path = pitch_job
    foreign = tmp_path / "foreign.npz"
    foreign.write_bytes(path.read_bytes())
    atomic_json(directory / "quality-evidence.json", {"denseVoiceAudit": {"contourFile": str(foreign)}})
    with pytest.raises(ValueError, match="当前工程"):
        read_pitch_window(directory, 0, 2)
    alias = path.parent / "linked" / "contours.npz"
    alias.parent.mkdir()
    alias.symlink_to(path)
    atomic_json(directory / "quality-evidence.json", {"denseVoiceAudit": {"contourFile": str(alias)}})
    with pytest.raises(ValueError, match="路径"):
        read_pitch_window(directory, 0, 2)


def test_rejects_a_symlinked_job_directory(pitch_job, tmp_path):
    alias = tmp_path / ("b" * 32)
    alias.symlink_to(pitch_job[0], target_is_directory=True)
    with pytest.raises(ValueError, match="符号链接"):
        read_pitch_window(alias, 0, 1)


def test_api_is_read_only_and_missing_evidence_is_not_demo(pitch_job, tmp_path):
    directory, _ = pitch_job
    with TestClient(create_app(tmp_path)) as client:
        result = client.get(f"/api/projects/{directory.name}/pitch?start=0.5&end=1")
        assert result.status_code == 200
        assert result.json()["frames"][0]["seconds"] == .5
        assert client.get(f"/api/projects/{directory.name}/pitch?start=0&end=300").status_code == 422
        overview = client.get(f"/api/projects/{directory.name}/pitch/coverage")
        assert overview.status_code == 200
        assert overview.json()["totalIntervals"] == 1
        assert str(directory) not in overview.text
        (directory / "quality-evidence.json").unlink()
        assert client.get(f"/api/projects/{directory.name}/pitch").status_code == 404
        assert client.get(f"/api/projects/{directory.name}/pitch/coverage").status_code == 404


def test_overview_uses_same_hash_verification_and_never_rewrites_files(pitch_job):
    directory, path = pitch_job
    before = path.read_bytes()
    result = read_pitch_coverage(directory)
    assert result["integrity"] == "stored_file"
    assert path.read_bytes() == before
    atomic_json(path.parent / "cache.json", {"contourSha256": "wrong"})
    with pytest.raises(ValueError, match="哈希"):
        read_pitch_coverage(directory)


def test_directory_instead_of_contour_is_rejected_without_index_error(pitch_job):
    directory, _ = pitch_job
    atomic_json(directory / "quality-evidence.json", {"denseVoiceAudit": {"contourFile": str(directory)}})
    with pytest.raises(ValueError, match="路径"):
        read_pitch_coverage(directory)

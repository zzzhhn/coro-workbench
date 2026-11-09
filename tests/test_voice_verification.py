from __future__ import annotations

import copy
import json
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from server.storage import Cancelled, atomic_json
from server import voice_verification as verification


def report(duration: float = 1) -> dict:
    return {"durationSeconds": duration, "processedSeconds": duration, "jointVoicedSeconds": .8 * duration, "within50CentsOnJointVoiced": .9, "over6SemitonesOnJointVoiced": .05, "unvoicedOrLowEvidenceSeconds": .2 * duration, "uncertaintyIntervals": [{"partId": "vocals", "startSeconds": .3, "endSeconds": .6, "reason": "dense octave disagreement", "alternatives": ["CREPE"]}], "lowPeriodicityIntervals": []}


@pytest.fixture
def input_files(tmp_path, monkeypatch):
    lead = tmp_path / "lead.wav"
    sf.write(lead, np.ones(16000, dtype=np.float32) * .1, 16000)
    fcpe = tmp_path / "fcpe.npz"
    np.savez(fcpe, time=np.arange(100) * .01, f0=np.ones(100) * 440, activation=np.ones(100))
    monkeypatch.setattr(verification, "verification_signature", lambda a, b: {"leadSha256": verification.file_sha256(a), "fcpeSha256": verification.file_sha256(b), "auditVersion": verification.AUDIT_VERSION})
    return tmp_path, lead, fcpe


class Status:
    def __init__(self):
        self.updates = []
        self.checks = 0

    def check_cancelled(self):
        self.checks += 1

    def update(self, progress, stage, message):
        self.updates.append((progress, stage, message))


def test_cache_uses_audio_and_fcpe_identity_and_verifies_output_hashes(input_files, monkeypatch):
    directory, lead, fcpe = input_files
    calls = []
    class Process:
        returncode = 0
        def __init__(self, command, **kwargs):
            calls.append(command)
            assert "start_new_session" not in kwargs
            output = Path(command[-1])
            atomic_json(output / "report.json", report())
            np.savez(output / "contours.npz", time=np.arange(50) * .02)
        def poll(self):
            return self.returncode
        def wait(self, timeout=None):
            return self.returncode
    monkeypatch.setattr(verification.subprocess, "Popen", Process)
    state = Status()
    first = verification.run_dense_voice_verification(directory, lead, fcpe, state)
    second = verification.run_dense_voice_verification(directory, lead, fcpe, state)
    assert first["cacheHit"] is False and second["cacheHit"] is True
    assert len(calls) == 1
    assert all(97 <= progress <= 99 for progress, _, _ in state.updates)
    # Altered posterior must not reuse a report for another f0 contour.
    np.savez(fcpe, time=np.arange(100) * .01, f0=np.ones(100) * 220, activation=np.ones(100))
    third = verification.run_dense_voice_verification(directory, lead, fcpe, state)
    assert not third["cacheHit"] and len(calls) == 2
    # Tampered cached artifacts cannot be promoted to verified success.
    Path(third["contourFile"]).write_bytes(b"corrupted")
    fourth = verification.run_dense_voice_verification(directory, lead, fcpe, state)
    assert not fourth["cacheHit"] and len(calls) == 3


def test_cancel_terminates_subprocess_and_never_marks_complete(input_files, monkeypatch):
    directory, lead, fcpe = input_files
    processes = []
    class Process:
        returncode = None
        def __init__(self, *args, **kwargs):
            self.terminated = False
            processes.append(self)
        def poll(self):
            return self.returncode
        def terminate(self):
            self.terminated = True
            self.returncode = -15
        def wait(self, timeout=None):
            return self.returncode
    class CancelStatus(Status):
        def check_cancelled(self):
            super().check_cancelled()
            if self.checks >= 2:
                raise Cancelled()
    monkeypatch.setattr(verification.subprocess, "Popen", Process)
    status = CancelStatus()
    with pytest.raises(Cancelled):
        verification.run_dense_voice_verification(directory, lead, fcpe, status)
    assert processes[0].terminated
    assert max(update[0] for update in status.updates) < 100
    assert not list(directory.glob("dense-voice-audit/*/cache.json"))


def test_timeout_terminates_subprocess(input_files, monkeypatch):
    directory, lead, fcpe = input_files
    processes = []
    class Process:
        returncode = None
        def __init__(self, *args, **kwargs):
            processes.append(self)
        def poll(self):
            return self.returncode
        def terminate(self):
            self.returncode = -15
        def wait(self, timeout=None):
            return self.returncode
    monkeypatch.setattr(verification.subprocess, "Popen", Process)
    with pytest.raises(ValueError, match="超时"):
        verification.run_dense_voice_verification(directory, lead, fcpe, timeout_seconds=0)
    assert processes[0].returncode == -15


def test_no_lead_is_not_full_verification(tmp_path):
    with pytest.raises(ValueError, match="没有完整主唱"):
        verification.run_dense_voice_verification(tmp_path, tmp_path / "missing.wav", tmp_path / "missing.npz")


def test_dense_metadata_is_merged_without_changing_notes_or_source_mapping():
    project = {"parts": [{"id": "vocals", "name": "主唱旋律提案", "notes": [{"midi": 60, "start": 1.5, "duration": .125}]}], "originalAudio": {"offsetSeconds": -.5, "tempo": 110}, "source": {"warnings": ["独立音高检查仅抽样9秒", "retain me"], "analysis": {"quality": {}, "transforms": [], "uncertaintyIntervals": [{"partId": "vocals", "startSeconds": .1, "endSeconds": .4, "reason": "sampled disagreement", "alternatives": ["FCPE"]}]}}}
    old_notes = copy.deepcopy(project["parts"][0]["notes"])
    old_mapping = copy.deepcopy(project["originalAudio"])
    evidence = {}
    verification.apply_dense_voice_evidence(project, evidence, report())
    assert project["parts"][0]["notes"] == old_notes
    assert project["originalAudio"] == old_mapping
    quality = project["source"]["analysis"]["quality"]
    assert quality["verificationStatus"] == "complete" and quality["verificationMode"] == "full"
    assert quality["vocals.denseLowEvidenceSeconds"] == .2
    assert quality["vocals.leadIdentityAccepted"] is False
    merged = project["source"]["analysis"]["uncertaintyIntervals"]
    assert len(merged) == 1 and merged[0]["startSeconds"] == .1 and merged[0]["endSeconds"] == .6
    assert set(merged[0]["alternatives"]) == {"FCPE", "CREPE"}
    assert evidence["denseVoiceAudit"] == report()
    assert "retain me" in project["source"]["warnings"]
    assert not any(message.startswith("独立音高检查仅抽样") for message in project["source"]["warnings"])


@pytest.mark.parametrize("mode", ["quick", "multi"])
def test_full_request_without_separated_lead_is_explicitly_not_applicable(tmp_path, monkeypatch, mode):
    import server.audio_quality as quality_module
    sf.write(tmp_path / "analysis.wav", np.ones((16000, 2), dtype=np.float32) * .1, 16000)
    model_dir = tmp_path / "quality-models"
    model_dir.mkdir()
    atomic_json(model_dir / "models.json", {"engines": {}, "errors": {}})
    np.savez(model_dir / "rhythm.npz", beats=np.array([]), downbeats=np.array([]))
    monkeypatch.setattr(quality_module, "run_quality_models", lambda *args, **kwargs: model_dir)
    project = {"id": "no-lead", "tempo": 120., "measures": 1, "parts": [{"id": "mix", "name": "Mix", "role": "instrument", "notes": [{"id": "n1", "midi": 60, "start": 0., "duration": 1., "velocity": .8}]}], "source": {"warnings": [], "engine": "test"}, "originalAudio": {"tempo": 120., "offsetSeconds": 0}}
    raw = {'multi': {'events': [{'start': 0., 'end': .5, 'midi': 60, 'program': 0, 'isDrum': False}]}} if mode == 'multi' else {}
    result = quality_module.improve_project(tmp_path, project, {"mode": mode, "tempo": 120., "verification": "full"}, {}, raw)
    q = result["source"]["analysis"]["quality"]
    assert q["verificationMode"] == "full" and q["verificationStatus"] == "not_applicable"
    assert "vocals.denseVerifiedSeconds" not in q
    assert not (tmp_path / "dense-voice-audit").exists()


def test_sampled_request_does_not_run_dense_even_if_lead_files_exist(tmp_path, monkeypatch):
    import server.audio_quality as quality_module
    sf.write(tmp_path / "analysis.wav", np.ones((16000, 2), dtype=np.float32) * .1, 16000)
    model_dir = tmp_path / "quality-models"
    model_dir.mkdir()
    atomic_json(model_dir / "models.json", {"engines": {}, "errors": {}})
    np.savez(model_dir / "rhythm.npz", beats=np.array([]), downbeats=np.array([]))
    monkeypatch.setattr(quality_module, "run_quality_models", lambda *args, **kwargs: model_dir)
    monkeypatch.setattr(verification, "run_dense_voice_verification", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("dense run was not requested")))
    project = {"id": "sampled", "tempo": 120., "measures": 1, "parts": [{"id": "mix", "name": "Mix", "role": "instrument", "notes": [{"id": "n1", "midi": 60, "start": 0., "duration": 1., "velocity": .8}]}], "source": {"warnings": [], "engine": "test"}, "originalAudio": {"tempo": 120., "offsetSeconds": 0}}
    result = quality_module.improve_project(tmp_path, project, {"mode": "separate", "tempo": 120., "verification": "sampled"}, {}, {})
    assert result["source"]["analysis"]["quality"]["verificationStatus"] == "sampled"

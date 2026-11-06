from __future__ import annotations

import math
import json
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server import config
from server.app import create_app
from server.pipeline import consolidate_weak_tails, infer_chords, quantize_notes
from server.storage import Cancelled, JobStatus, atomic_json


@pytest.fixture
def client(tmp_path, monkeypatch):
    app = create_app(tmp_path)
    monkeypatch.setattr(config, "engine_health", lambda: {"basicPitch": {"ready": True}, "demucs": {"ready": True}, "instrumentClassifier": {"ready": True}, "ffmpeg": {"ready": True}})
    monkeypatch.setattr(app.state.manager, "submit", lambda job_id: None)
    with TestClient(app) as transport:
        yield transport, app, tmp_path


def fake_upload(transport, **kwargs):
    return transport.post("/api/analyze", files={"file": ("melody.wav", b"RIFF" + b"0" * 80, "audio/wav")}, **kwargs)


def test_health_does_not_load_models(client):
    transport, _, _ = client
    result = transport.get("/api/health")
    assert result.status_code == 200
    assert result.json()["localOnly"] is True
    assert result.json()["status"] == "ok"


def test_upload_stores_only_generated_path(client):
    transport, _, directory = client
    result = transport.post("/api/analyze", files={"file": ("../../original.wav", b"RIFF" + b"0" * 80, "audio/wav")})
    assert result.status_code == 202
    job_id = result.json()["id"]
    assert len(job_id) == 32
    assert (directory / job_id / "source.wav").is_file()
    request = json.loads((directory / job_id / "request.json").read_text())
    assert request["decoder"] == "rosvot" and request["verification"] == "full"
    assert not (directory.parent / "original.wav").exists()
    status = transport.get(f"/api/jobs/{job_id}").json()
    assert status["status"] == "queued"


@pytest.mark.parametrize("data", [{"mode": "made-up"}, {"tempo": "NaN"}, {"tempo": "0"}, {"tempo": "241"}, {"max_seconds": "NaN"}, {"max_seconds": "0"}, {"max_seconds": "301"}])
def test_invalid_analysis_options(client, data):
    transport, _, _ = client
    assert fake_upload(transport, data=data).status_code == 422


def test_rejects_bad_extension_and_empty_file(client):
    transport, _, _ = client
    assert transport.post("/api/analyze", files={"file": ("shell.py", b"bad", "audio/wav")}).status_code == 415
    assert transport.post("/api/analyze", files={"file": ("empty.wav", b"", "audio/wav")}).status_code == 422


def test_rejects_huge_request_before_parsing(client):
    transport, _, _ = client
    result = transport.post("/api/analyze", headers={"Content-Length": str(105 * 1024 * 1024)}, content=b"x")
    assert result.status_code == 413


def test_missing_models_do_not_return_demo(client, monkeypatch):
    transport, _, _ = client
    monkeypatch.setattr(config, "engine_health", lambda: {"basicPitch": {"ready": False}, "demucs": {"ready": False}, "ffmpeg": {"ready": True}})
    result = fake_upload(transport)
    assert result.status_code == 503
    assert "project" not in result.json()


def test_multi_missing_fails_without_substituting_baseline(client):
    transport, _, _ = client
    result = fake_upload(transport, data={"mode": "multi"})
    assert result.status_code == 503
    assert "多乐器族群" in result.json()["detail"]


def test_multi_family_labels_do_not_claim_individual_orchestra():
    from server.multi import family_for_program
    assert family_for_program(40)[0] == "strings"
    assert family_for_program(42)[0] == "strings"
    assert family_for_program(73)[0] == "pipes"
    assert family_for_program(100)[2] == "lead"
    assert family_for_program(0, True)[2] == "percussion"


def test_queue_bound(client, monkeypatch):
    transport, app, _ = client
    monkeypatch.setattr(app.state.manager, "reserve_upload", lambda: False)
    assert fake_upload(transport).status_code == 429


def test_host_and_origin_protection(client):
    transport, _, _ = client
    assert transport.get("/api/health", headers={"Host": "evil.example"}).status_code == 400
    assert fake_upload(transport, headers={"Origin": "https://evil.example"}).status_code == 403
    assert fake_upload(transport, headers={"Origin": "null"}).status_code == 403
    assert fake_upload(transport, headers={"Origin": "http://localhost:5173"}).status_code == 202


def test_cancel_is_terminal_even_if_worker_writes_complete(client):
    transport, _, directory = client
    job_id = fake_upload(transport).json()["id"]
    assert transport.delete(f"/api/jobs/{job_id}").json()["status"] == "cancelled"
    atomic_json(directory / job_id / "status.json", {"id": job_id, "status": "complete", "progress": 100, "project": {"fake": True}})
    result = transport.get(f"/api/jobs/{job_id}").json()
    assert result["status"] == "cancelled"
    assert "project" not in result
    with pytest.raises(Cancelled):
        JobStatus(directory / job_id).finish({})


def test_audio_byte_ranges_and_private_files(client):
    transport, _, directory = client
    job_id = fake_upload(transport).json()["id"]
    content = bytes(range(100))
    (directory / job_id / "original.wav").write_bytes(content)
    result = transport.get(f"/api/audio/{job_id}/original.wav", headers={"Range": "bytes=10-19"})
    assert result.status_code == 206
    assert result.content == content[10:20]
    assert result.headers["Content-Range"] == "bytes 10-19/100"
    assert transport.get(f"/api/audio/{job_id}/request.json").status_code == 404
    assert transport.get("/api/jobs/invalid-id").status_code == 404
    assert transport.get(f"/api/audio/{uuid.uuid4().hex}/original.wav").status_code == 404


def test_completed_results_history_preserves_jobs_and_exposes_only_summary(client):
    transport, _, directory = client
    job_id = fake_upload(transport).json()["id"]
    assert transport.get("/api/projects").json()["projects"] == []
    source = {"id": job_id, "title": "Song", "tempo": 100, "measures": 10, "parts": [{"id": "lead", "notes": []}], "originalAudio": {"duration": 120}, "source": {"filename": "song.mp3", "analysis": {"transforms": ["proposal"], "uncertaintyIntervals": [{"startSeconds": 2, "endSeconds": 3}], "quality": {"decoderProfile": "legato"}}}}
    atomic_json(directory / job_id / "status.json", {"id": job_id, "status": "complete", "project": source})
    result = transport.get("/api/projects").json()["projects"]
    assert len(result) == 1
    assert result[0]["title"] == "Song" and result[0]["uncertainRegions"] == 1
    assert result[0]["decoder"] == "legato" and "notes" not in result[0]
    assert transport.get(f"/api/jobs/{job_id}").json()["project"] == source
    assert transport.get("/api/projects?limit=999").status_code == 422


def test_history_uses_actual_analysis_audio_length_for_cached_results(client):
    import wave
    transport, _, directory = client
    job_id = fake_upload(transport).json()["id"]
    folder = directory / job_id
    atomic_json(folder / "request.json", {"input": "source.wav", "filename": "cached.wav", "mode": "separate"})
    atomic_json(folder / "status.json", {"id": job_id, "status": "complete", "project": {"title": "Cached", "parts": [], "originalAudio": {"duration": 200}, "source": {}}})
    with wave.open(str(folder / "analysis.wav"), "wb") as audio:
        audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(8000); audio.writeframes(b"\0\0" * 80000)
    result = transport.get("/api/projects").json()["projects"][0]
    assert result["duration"] == 200
    assert result["analyzedSeconds"] == 10


@pytest.mark.parametrize("data", [{"quality": "delete_notes"}, {"decoder": "detailed"}, {"verification": "trust_model"}])
def test_rejects_unknown_quality_decoder_and_verification(client, data):
    transport, _, _ = client
    assert fake_upload(transport, data=data).status_code == 422


@pytest.mark.parametrize("options, expected", [({}, "full"), ({"verification": "full"}, "full"), ({"verification": "sampled"}, "sampled")])
def test_persists_verification_choice(client, options, expected):
    from server.storage import read_json
    transport, _, directory = client
    result = fake_upload(transport, data={"mode": "separate", **options})
    assert result.status_code == 202
    request = read_json(directory / result.json()["id"] / "request.json")
    assert request["verification"] == expected


def test_download_original_preserves_exact_uploaded_bytes(client):
    transport, _, directory = client
    content = b"RIFF" + b"original-not-transcoded" * 10
    response = transport.post("/api/analyze", files={"file": ("my-song.wav", content, "audio/wav")})
    job_id = response.json()["id"]
    (directory / job_id / "original.wav").write_bytes(b"different decoded data")
    downloaded = transport.get(f"/api/source/{job_id}")
    assert downloaded.status_code == 200
    assert downloaded.content == content
    assert "my-song.wav" in downloaded.headers["Content-Disposition"]
    assert transport.get(f"/api/audio/{job_id}/source.wav").status_code == 404


def test_quantization_finite_and_id_invariants():
    events = [(0.11, 0.65, 60, 0.7), (0.12, 0.6, 60, 0.8), (0.5, 1.0, 60, 0.9), (float("nan"), 2, 64, 0.7), (1, 1.01, 67, 0.2), (1.5, 2.2, 72, 0.8)]
    notes = quantize_notes(events, 120, 2.0, "mix")
    assert len(notes) == 3
    assert len({n["id"] for n in notes}) == 3
    assert all(math.isfinite(n["start"]) and n["start"] >= 0 for n in notes)
    assert all(n["duration"] > 0 and n["start"] * 4 == round(n["start"] * 4) for n in notes)
    assert notes[0]["start"] + notes[0]["duration"] <= notes[1]["start"]
    assert notes[0]["confidence"] == 0.8
    assert quantize_notes([], 120, 10, "mix") == []


def test_chord_inference_and_percussion_exclusion():
    notes = [{"midi": p, "start": 0, "duration": 4, "velocity": 0.8} for p in [60, 64, 67]]
    parts = [{"role": "instrument", "notes": notes}, {"role": "percussion", "notes": [{"midi": 38, "start": 0, "duration": 4, "velocity": 1}]}]
    chords = infer_chords(parts, 8)
    assert len(chords) == 1
    assert chords[0]["symbol"] == "C"
    assert chords[0]["pitches"] == [48, 52, 55]
    assert infer_chords([{"role": "percussion", "notes": notes}], 4) == []


def test_merge_fading_short_tail_but_preserve_reattack():
    import numpy as np
    events = [(0, 0.4, 60, 0.8, None), (0.4, 0.5, 60, 0.6, None)]
    fading = np.linspace(1, 0, 1000)
    merged = consolidate_weak_tails(events, fading, 1000)
    assert len(merged) == 1 and merged[0][1] == 0.5
    reattack = fading.copy()
    reattack[400:430] = 1
    assert len(consolidate_weak_tails(events, reattack, 1000)) == 2
    assert len(consolidate_weak_tails([(0, .1, 60, .8), (.1, .2, 60, .6)], fading, 1000)) == 2

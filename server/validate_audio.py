"""Run a real, independently scored local audio smoke evaluation."""
from __future__ import annotations

import io
import json
import time
import uuid
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient
from scipy.optimize import linear_sum_assignment

from .app import create_app
from .config import ROOT
from .fixtures import create_fixture, create_multitrack_fixture


def onset_metrics(truth: list[dict], parts: list[dict], tempo: float, tolerance: float = .125, require_part: bool = False) -> dict:
    references = [note for note in truth if note.get("part") != "drums"]
    predicted = [(part["id"], n) for part in parts if part["role"] != "percussion" for n in part["notes"] if n["midi"] is not None]
    cost = np.full((len(references), len(predicted)), 1e6)
    for i, note in enumerate(references):
        for j, (part, actual) in enumerate(predicted):
            delta = abs(note["start"] - actual["start"] * 60 / tempo)
            if note["midi"] == actual["midi"] and delta <= tolerance and (not require_part or part == note.get("part")):
                cost[i, j] = delta
    row, col = linear_sum_assignment(cost)
    matched = sum(cost[i, j] < 1e5 for i, j in zip(row, col))
    precision = matched / max(1, len(predicted))
    recall = matched / max(1, len(references))
    return {"pitchToleranceSemitones": 0, "onsetToleranceSeconds": tolerance, "requireSourcePartMatch": require_part, "referenceNotes": len(references), "predictedNotes": len(predicted), "matchedNotes": int(matched), "precision": round(precision, 4), "recall": round(recall, 4), "f1": round(2 * precision * recall / max(1e-8, precision + recall), 4), "offsetsScored": False}


def si_sdr(reference: np.ndarray, estimate: np.ndarray) -> float:
    reference = reference.mean(axis=1)
    estimate = estimate[:len(reference)].mean(axis=1)
    reference -= reference.mean()
    estimate -= estimate.mean()
    scale = np.dot(estimate, reference) / max(np.dot(reference, reference), 1e-12)
    target = scale * reference
    noise = estimate - target
    return round(float(10 * np.log10((np.dot(target, target) + 1e-12) / (np.dot(noise, noise) + 1e-12))), 3)


def wait(transport: TestClient, job_id: str) -> dict:
    last = None
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        status = transport.get(f"/api/jobs/{job_id}").json()
        stage = status["status"], status["progress"], status["message"]
        if stage != last:
            print(stage, flush=True)
            last = stage
        if status["status"] in {"complete", "cancelled", "error"}:
            return status
        time.sleep(.4)
    raise AssertionError("Local audio validation timed out")


def main() -> None:
    run_id = uuid.uuid4().hex[:10]
    data_dir = ROOT / "data" / f"validation-{run_id}"
    fixtures = data_dir / "fixtures"
    melody_path, melody_truth = create_fixture(fixtures)
    trio_path, trio_truth = create_multitrack_fixture(fixtures)
    results = []
    checks = {}
    app = create_app(data_dir)
    with TestClient(app) as transport:
        for name, path, truth, mode in [("additive-melody", melody_path, melody_truth, "quick"), ("sampled-trio", trio_path, trio_truth, "quick"), ("sampled-trio", trio_path, trio_truth, "separate")]:
            print("RUN", name, mode, flush=True)
            start = time.monotonic()
            with path.open("rb") as handle:
                result = transport.post("/api/analyze", files={"file": (path.name, handle, "audio/wav")}, data={"mode": mode, "tempo": 120, "max_seconds": 11})
            assert result.status_code == 202, result.text
            status = wait(transport, result.json()["id"])
            assert status["status"] == "complete", status
            project = status["project"]
            item = {"fixture": name, "mode": mode, "jobId": status["id"], "wallSeconds": round(time.monotonic() - start, 3), "metrics": onset_metrics(truth, project["parts"], project["tempo"]), "instrumentCandidates": project["source"]["detectedInstruments"], "noteCounts": {p["id"]: len(p["notes"]) for p in project["parts"]}, "warnings": project["source"]["warnings"]}
            if mode == "separate":
                item["sourceAwareMetrics"] = onset_metrics(truth, project["parts"], project["tempo"], require_part=True)
                scores = {}
                for source in ("piano", "bass", "drums"):
                    reference, _ = sf.read(fixtures / f"truth-{source}.wav", always_2d=True)
                    estimate, _ = sf.read(data_dir / status["id"] / f"stem-{source}.wav", always_2d=True)
                    scores[source] = si_sdr(reference, estimate)
                item["sourceSiSdrDb"] = scores
                checks["separate_returns_real_stems"] = all((data_dir / status["id"] / f"stem-{s}.wav").is_file() for s in ("piano", "bass", "drums", "vocals", "guitar", "other"))
                checks["score_has_percussion"] = any(p["role"] == "percussion" for p in project["parts"])
            result = transport.get(project["originalAudio"]["url"], headers={"Range": "bytes=0-43"})
            checks["audio_range_requests"] = result.status_code == 206 and result.content[:4] == b"RIFF"
            checks["source_bpm_preserved"] = project["originalAudio"]["tempo"] == 120
            (data_dir / status["id"] / "validation-project.json").write_text(json.dumps(project, ensure_ascii=False, indent=2), encoding="utf-8")
            results.append(item)
        for name, content in [("corrupt", b"not an audio file" * 6), ("playlist", b"#EXTM3U\nhttps://example.com/something.mp3\n" * 2)]:
            response = transport.post("/api/analyze", files={"file": (f"{name}.wav", content, "audio/wav")})
            result = wait(transport, response.json()["id"])
            checks[name + "_rejected"] = result["status"] == "error" and "project" not in result
        silent = io.BytesIO()
        sf.write(silent, np.zeros(44100), 44100, format="WAV")
        response = transport.post("/api/analyze", files={"file": ("silent.wav", silent.getvalue(), "audio/wav")})
        result = wait(transport, response.json()["id"])
        checks["silence_rejected"] = result["status"] == "error" and "静音" in result["message"]
        with trio_path.open("rb") as handle:
            response = transport.post("/api/analyze", files={"file": ("cancel.wav", handle, "audio/wav")}, data={"mode": "separate"})
        job_id = response.json()["id"]
        time.sleep(.8)
        cancel = transport.delete(f"/api/jobs/{job_id}").json()
        time.sleep(.4)
        checks["running_cancel_is_terminal"] = cancel["status"] == "cancelled" and transport.get(f"/api/jobs/{job_id}").json()["status"] == "cancelled"
        checks["cancel_stops_worker"] = job_id not in app.state.manager.processes
        with melody_path.open("rb") as handle:
            response = transport.post("/api/analyze", files={"file": ("trim.wav", handle, "audio/wav")}, data={"mode": "quick", "max_seconds": 2, "tempo": 120})
        result = wait(transport, response.json()["id"])
        checks["trim_notice_and_original_preserved"] = result["status"] == "complete" and result["project"]["originalAudio"]["duration"] == 10 and any("只分析前 2.0 秒" in w for w in result["project"]["source"]["warnings"])
    report = {"runId": run_id, "dataDirectory": str(data_dir), "scope": "Original synthetic/sampled fixtures only. Not real-song or orchestral accuracy, not human listening acceptance. Metrics scored independently with Hungarian onset/pitch matching on final quantized notes; offsets not scored.", "results": results, "checks": checks}
    output = ROOT / "evidence" / "audio-validation.json"
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    assert all(checks.values()), checks


if __name__ == "__main__":
    main()

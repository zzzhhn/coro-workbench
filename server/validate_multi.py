"""Repeatable real-model comparison, including a held-out chamber fixture."""
from __future__ import annotations

import json
import time
import uuid

from fastapi.testclient import TestClient

from .app import create_app
from .config import ROOT
from .fixtures import create_multitrack_fixture
from .validate_audio import onset_metrics, wait


def main() -> None:
    fixtures = ROOT / "data" / "fixtures"
    create_multitrack_fixture(fixtures)
    create_multitrack_fixture(fixtures, orchestra=True)
    create_multitrack_fixture(fixtures, orchestra=True, orchestra_drums=True)
    root = ROOT / "data" / f"multi-validation-{uuid.uuid4().hex[:8]}"
    app = create_app(root)
    results = []
    checks = {}
    with TestClient(app) as transport:
        for name, mode in [("original-trio", "multi"), ("heldout-chamber", "multi"), ("heldout-chamber-drums", "multi"), ("heldout-chamber-drums", "separate")]:
            start = time.monotonic()
            with (fixtures / f"{name}.wav").open("rb") as handle:
                response = transport.post("/api/analyze", files={"file": (f"{name}.wav", handle, "audio/wav")}, data={"mode": mode, "tempo": 120, "max_seconds": 11})
            assert response.status_code == 202, response.text
            print("RUN", name, mode, flush=True)
            result = wait(transport, response.json()["id"])
            assert result["status"] == "complete", result
            project = result["project"]
            truth = json.loads((fixtures / f"{name}.truth.json").read_text())["notes"]
            row = {"fixture": name, "mode": mode, "wallSeconds": round(time.monotonic() - start, 3), "jobId": result["id"], "pitchedMetrics": onset_metrics(truth, project["parts"], 120), "noteCounts": {part["id"]: len(part["notes"]) for part in project["parts"]}, "warnings": project["source"]["warnings"]}
            if "chamber" in name:
                for note in truth:
                    note["part"] = {"violin": "strings", "cello": "strings", "flute": "pipes", "drums": "drums"}[note["part"]]
            row["familyAwareMetrics"] = onset_metrics(truth, project["parts"], 120, require_part=True)
            row["noFakeStemUrls"] = all("stemUrl" not in part for part in project["parts"]) if mode == "multi" else None
            if mode == "multi":
                checks["no_fake_stem_urls"] = row["noFakeStemUrls"]
                checks["no_fake_note_confidence"] = all("confidence" not in note for part in project["parts"] for note in part["notes"])
                checks["unique_note_ids"] = all(len({n["id"] for n in part["notes"]}) == len(part["notes"]) for part in project["parts"])
            results.append(row)
            (root / result["id"] / "verified-project.json").write_text(json.dumps(project, ensure_ascii=False, indent=2), encoding="utf-8")
        with (fixtures / "heldout-chamber-drums.wav").open("rb") as handle:
            response = transport.post("/api/analyze", files={"file": ("cancel-multi.wav", handle, "audio/wav")}, data={"mode": "multi", "tempo": 120})
        job = response.json()["id"]
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            state = transport.get(f"/api/jobs/{job}").json()
            if state["stage"] == "multi":
                break
            assert state["status"] not in {"error", "complete"}, state
            time.sleep(.1)
        result = transport.delete(f"/api/jobs/{job}").json()
        time.sleep(.5)
        checks["multi_cancel_terminal"] = result["status"] == "cancelled" and transport.get(f"/api/jobs/{job}").json()["status"] == "cancelled"
        checks["multi_parent_worker_stopped"] = job not in app.state.manager.processes
    report = {"dataDirectory": str(root), "scope": "Original sampled fixtures, not real recordings or human listening acceptance. Exact pitch and onset +/-125ms on final quantized score. Violin/cello are grouped strings; flute grouped pipes. Held-out chamber/drum results retained, no tuning for this fixture.", "results": results, "checks": checks}
    (ROOT / "evidence" / "yourmt3-validation.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    assert all(checks.values()), checks
    from .evaluate_multi import main as evaluate
    evaluate()


if __name__ == "__main__":
    main()

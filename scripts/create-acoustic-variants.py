"""Create separate four-song results from cached lead F0; never overwrite sources."""
from pathlib import Path
import copy
import hashlib
import json
import math
import shutil
import sys
import uuid

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from server.pitch_evidence import read_pitch_window
from server.audio_quality import note_quality
from server.rhythm import quantize_on_grid
from server.storage import atomic_json, utc_now
from server.vocal_decode import DECODER_VERSIONS, decode_selected_contour


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    manifest_path = ROOT / "evidence/phase4/four-acoustic-songs.json"
    if manifest_path.exists():
        raise RuntimeError("Existing variant manifest retained; no duplicate projects created")
    holdout = json.loads((ROOT / "evidence/phase4/vocadito-holdout-decoders.json").read_text())
    assert holdout["predeclaredBenchmarkGate"]["passesBenchmarkOnly"]
    original = json.loads((ROOT / "evidence/phase2/four-full-songs.json").read_text())
    output = {"inputs": original["inputs"], "results": [], "scope": "New opt-in acoustic note segmentation; source media, all other parts and original results unchanged. Not human truth on these songs."}
    for entry in original["results"]:
        parent = ROOT / "data" / entry["jobId"]
        source_path = parent / "project.json"
        source = json.loads(source_path.read_text())
        evidence_path = parent / "quality-evidence.json"
        evidence = json.loads(evidence_path.read_text())
        lead_path = parent / "stem-lead.wav"
        contour_path = parent / "lead-identity/lead-models/vocals-fcpe.npz"
        hashes = {str(path.relative_to(ROOT)): sha(path) for path in [source_path, evidence_path, parent / "status.json", lead_path, contour_path]}
        with np.load(contour_path, allow_pickle=False) as track:
            audio, sr = sf.read(lead_path, dtype="float32", always_2d=True)
            events, details = decode_selected_contour(track["time"], track["f0"], track["activation"], audio.mean(axis=1), sr, profile="acoustic")
        assert events, "Empty acoustic output must not replace a saved melody"
        duration = len(audio) / sr
        notes = quantize_on_grid(events, evidence["grid"], duration, "vocals", monophonic=True, quantum=.125)
        project = copy.deepcopy(source)
        project["id"] = uuid.uuid4().hex
        project["title"] += " · 声学起止"
        project["updatedAt"] = utc_now()
        vocal = next(part for part in project["parts"] if part["id"] == "vocals")
        before_notes = len(vocal["notes"])
        vocal["notes"] = notes
        vocal["name"] = "主唱提案 · 声学起止待校对"
        total = max(note["start"] + note["duration"] for part in project["parts"] for note in part["notes"])
        project["measures"] = max(project["measures"], math.ceil(total / (project["timeSignature"][0] * 4 / project["timeSignature"][1])))
        analysis = project["source"]["analysis"]
        analysis["transforms"].append("从保留的全曲主唱FCPE重新做声学起止分段，另存新结果；不重跑分离或音高模型，不改其它声部、和弦、拍点或原始文件。")
        analysis["quality"].update(decoderProfile="acoustic", decoderVersion=DECODER_VERSIONS["acoustic"],
                                   derivedFromJob=entry["jobId"], groundTruthAvailable=False)
        analysis["quality"].update(note_quality(project["parts"]))
        analysis["rawProjectUrl"] = f"/api/projects/{project['id']}/raw"
        analysis["quality"]["modelEvidenceUrl"] = f"/api/projects/{project['id']}/evidence"
        project["source"]["warnings"].append("声学起止为独立备选，不补缺失音高；短装饰音仍可能合并。清唱人审参考的改善不证明这首商业混音已准确。")
        destination = ROOT / "data" / project["id"]
        destination.mkdir()
        audit_path = destination / "dense-voice-audit" / "contours.npz"
        audit_path.parent.mkdir()
        original_audit = Path(evidence["denseVoiceAudit"]["contourFile"])
        shutil.copyfile(original_audit, audit_path)
        # The copy has an independently checked byte identity, not a new model run.
        assert sha(audit_path) == sha(original_audit)
        atomic_json(audit_path.parent / "cache.json", {"contourSha256": sha(audit_path), "copiedFromJob": entry["jobId"]})
        evidence["denseVoiceAudit"]["contourFile"] = str(audit_path)
        evidence["acousticRevision"] = {"sourceJob": entry["jobId"], "originalInputHashes": hashes, "events": events, "details": details,
                                        "outputNotes": len(notes), "otherPartsAndHarmonyUnchanged": True, "newNeuralInference": False,
                                        "baseEvidenceNote": "Base parts/beforeMetrics/afterMetrics describe the retained prior proposal; this section and revisionMetrics describe the new decoder."}
        evidence["revisionMetrics"] = note_quality(project["parts"])
        atomic_json(destination / "quality-evidence.json", evidence)
        shutil.copyfile(parent / "raw-project.json", destination / "raw-project.json")
        request = json.loads((parent / "request.json").read_text())
        request.update(decoder="acoustic", derivedFromJob=entry["jobId"], max_seconds=duration)
        atomic_json(destination / "request.json", request)
        atomic_json(destination / "project.json", project)
        state = {"id": project["id"], "createdAt": utc_now(), "updatedAt": utc_now(), "status": "complete", "stage": "complete",
                 "progress": 100, "message": "已从缓存创建独立声学起止提案；原工程不变。", "project": project}
        atomic_json(destination / "status.json", state)
        for part in source["parts"]:
            if part["id"] != "vocals":
                assert part == next(other for other in project["parts"] if other["id"] == part["id"])
        assert project["chords"] == source["chords"] and project["originalAudio"] == source["originalAudio"]
        assert all(sha(ROOT / path) == value for path, value in hashes.items())
        assert read_pitch_window(destination, 0, 8)["integrity"] == "sha256_checked"
        row = {"filename": entry["filename"], "jobId": project["id"], "sourceJobId": entry["jobId"],
               "projectPath": str(destination / "project.json"), "rawProjectPath": str(destination / "raw-project.json"),
               "beforeLeadNotes": before_notes, "acousticEventsBeforeQuantization": len(events), "afterLeadNotes": len(notes),
               "originalInputHashes": hashes, "sourceAndOtherPartsUnchanged": True, "newNeuralInference": False}
        output["results"].append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)
    atomic_json(manifest_path, output)


if __name__ == "__main__":
    main()

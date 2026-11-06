"""Create independent audio-harmony results, retaining the acoustic melody and sources."""
from pathlib import Path
import copy
import json
import shutil
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from server.audio_harmony import ACCOMPANIMENT, accompaniment_harmony
from server.chordino import sha
from server.pitch_evidence import read_pitch_window
from server.storage import atomic_json, utc_now


def main():
    manifest_path = ROOT / "evidence/phase5/four-audio-harmony-songs.json"
    if manifest_path.exists():
        raise RuntimeError("Existing result manifest retained; no duplicate projects created")
    original = json.loads((ROOT / "evidence/phase4/four-acoustic-songs.json").read_text())
    output = {"inputs": original["inputs"], "results": [], "scope": "Four separately saved full-song acoustic melody + actual Chordino accompaniment analyses. Source notes/media/projects unchanged; no human chord truth."}
    for entry in original["results"]:
        parent = ROOT / "data" / entry["jobId"]
        stem_parent = ROOT / "data" / entry["sourceJobId"]
        source = json.loads((parent / "project.json").read_text())
        evidence = json.loads((parent / "quality-evidence.json").read_text())
        stems = {name: stem_parent / f"stem-{name}.wav" for name in ACCOMPANIMENT}
        guarded = [parent / name for name in ("project.json", "status.json", "quality-evidence.json", "raw-project.json")]
        guarded += [stem_parent / "status.json", stem_parent / "project.json", *stems.values()]
        guarded += list(stem_parent.glob("source.*"))
        hashes = {str(path.relative_to(ROOT)): sha(path) for path in guarded}
        project = copy.deepcopy(source)
        project["id"] = uuid.uuid4().hex
        destination = ROOT / "data" / project["id"]
        destination.mkdir()
        bpm, offset = project["tempo"], project["originalAudio"]["offsetSeconds"]
        total = project["measures"] * project["timeSignature"][0] * 4 / project["timeSignature"][1]
        project["chords"], report = accompaniment_harmony(destination, stems, bpm, offset, total)
        project["title"] += " · 伴奏和声"
        project["createdAt"] = project["updatedAt"] = utc_now()
        analysis = project["source"]["analysis"]
        analysis["transforms"] = ["前序版本记录：" + text if "和弦" in text else text for text in analysis["transforms"]]
        analysis["transforms"].append("本版本和弦改从piano/guitar/bass/other分离伴奏音频独立辨识；保留七和弦/转位与N间隙，变化点按四分之一拍整理。主唱及所有乐器音符、原拍点不变。")
        analysis["quality"].update({"harmony.engine": "Chordino audio accompaniment", "harmony.preserveGaps": True,
                                    "harmony.noChordSeconds": report["scoreGridEditorial"]["noChordSeconds"],
                                    "harmony.boundaryQuantumBeats": report["scoreGridEditorial"]["quantumBeats"],
                                    "derivedFromJob": entry["jobId"], "groundTruthAvailable": False,
                                    "modelEvidenceUrl": f"/api/projects/{project['id']}/evidence"})
        analysis["rawProjectUrl"] = f"/api/projects/{project['id']}/raw"
        project["source"]["warnings"] = [text for text in project["source"]["warnings"] if not text.startswith("和弦按每小节")]
        project["source"]["warnings"].append("和弦来自分离伴奏的Chordino音频候选；N表示未辨识到和弦，不保证真正无和声。挂留/减七与串音仍可能误判，允许编辑后重新编配。")
        audit_path = destination / "dense-voice-audit/contours.npz"
        audit_path.parent.mkdir()
        original_audit = Path(evidence["denseVoiceAudit"]["contourFile"])
        shutil.copyfile(original_audit, audit_path)
        assert sha(audit_path) == sha(original_audit)
        atomic_json(audit_path.parent / "cache.json", {"contourSha256": sha(audit_path), "copiedFromJob": entry["jobId"]})
        evidence["denseVoiceAudit"]["contourFile"] = str(audit_path)
        evidence["symbolicHarmonyAlternative"] = source["chords"]
        evidence["audioHarmony"] = report
        evidence["audioHarmonyRevision"] = {"sourceJob": entry["jobId"], "stemSourceJob": entry["sourceJobId"],
                                             "originalInputHashes": hashes, "notesAndMediaUnchanged": True,
                                             "newNeuralInference": False, "newNativeHarmonyInference": True}
        atomic_json(destination / "quality-evidence.json", evidence)
        shutil.copyfile(parent / "raw-project.json", destination / "raw-project.json")
        request = json.loads((parent / "request.json").read_text())
        request.update(id=project["id"], derivedFromJob=entry["jobId"], harmony="chordino-accompaniment")
        atomic_json(destination / "request.json", request)
        atomic_json(destination / "project.json", project)
        atomic_json(destination / "status.json", {"id": project["id"], "createdAt": utc_now(), "updatedAt": utc_now(), "status": "complete",
                    "stage": "complete", "progress": 100, "message": "已另存声学起止与伴奏和声完整结果；原工程不变。", "project": project})
        assert project["parts"] == source["parts"] and project["originalAudio"] == source["originalAudio"]
        assert all(sha(ROOT / path) == value for path, value in hashes.items())
        assert read_pitch_window(destination, 0, 8)["integrity"] == "sha256_checked"
        row = {"filename": entry["filename"], "jobId": project["id"], "sourceJobId": entry["jobId"],
               "projectPath": str(destination / "project.json"), "rawProjectPath": str(destination / "raw-project.json"),
               "beforeChords": len(source["chords"]), "afterChords": len(project["chords"]),
               "harmonyGrid": report["scoreGridEditorial"], "nativeRuntimeSeconds": report["runtimeSeconds"],
               "originalInputHashes": hashes, "sourceNotesAndMediaUnchanged": True}
        output["results"].append(row)
        print(json.dumps({key: value for key, value in row.items() if key != "originalInputHashes"}, ensure_ascii=False), flush=True)
    atomic_json(manifest_path, output)


if __name__ == "__main__":
    main()

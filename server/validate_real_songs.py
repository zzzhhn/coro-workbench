"""Local-only reproducible real-recording audit; no unannotated accuracy claims."""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import uuid
from pathlib import Path

from . import config
from .audio_quality import improve_project, note_quality
from .pipeline import analyze_audio
from .storage import JobStatus, atomic_json, utc_now


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description="Analyze local user MP3s, preserve raw and identity-aware proposal pairs.")
    parser.add_argument("--audio-dir", type=Path, default=config.ROOT / "audio")
    parser.add_argument("--full", action="store_true", help="Analyze up to300s of each full original instead of90s development +30s hold-out.")
    parser.add_argument("--development-seconds", type=float, default=90)
    parser.add_argument("--holdout-start", type=float, default=110)
    parser.add_argument("--holdout-seconds", type=float, default=30)
    parser.add_argument("--output", type=Path, default=config.ROOT / "evidence/phase2/real-song-retest.json")
    args = parser.parse_args()
    songs = sorted(args.audio_dir.glob("*.mp3"))
    if not songs:
        raise SystemExit("No local MP3 inputs. This command never downloads user songs.")
    report = {"createdAt": utc_now(), "scope": "Mechanical behavior and independent model-consistency evaluation on user recordings; no annotated ground truth, no human listening acceptance.", "fullSongMode": args.full, "inputs": [{"filename": song.name, "sha256": sha256(song)} for song in songs], "results": []}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    splits = [("full", 0, 300)] if args.full else [("development", 0, args.development_seconds), ("holdout", args.holdout_start, args.holdout_seconds)]
    for song in songs:
        for split, start, length in splits:
            job_id = uuid.uuid4().hex
            directory = config.DATA_DIR / job_id
            directory.mkdir(parents=True)
            if start:
                source = directory / "source.wav"
                subprocess.run([config.binary("ffmpeg"), "-v", "error", "-nostdin", "-y", "-ss", str(start), "-t", str(length), "-i", str(song), "-ac", "2", "-ar", "44100", str(source)], check=True)
            else:
                source = directory / "source.mp3"
                shutil.copyfile(song, source)
            request = {"id": job_id, "filename": song.name if not start else f"{song.stem} [{start:g}-{start + length:g}s].wav", "input": source.name, "mode": "separate", "quality": "raw", "tempo": None, "max_seconds": length}
            atomic_json(directory / "request.json", request)
            atomic_json(directory / "status.json", {"id": job_id, "status": "queued", "progress": 0, "stage": "queued", "message": "Real-song local audit", "createdAt": utc_now()})
            status = JobStatus(directory)
            print(f"Analyzing {song.name} {split} ({job_id})", flush=True)
            try:
                raw = analyze_audio(directory, request, status)
                events = json.loads((directory / "analysis-evidence.json").read_text())["rawNoteEventsSeconds"]
                paths = {part["id"]: directory / f"stem-{part['id']}.wav" for part in raw["parts"] if (directory / f"stem-{part['id']}.wav").is_file()}
                request["quality"] = "auto"
                project = improve_project(directory, raw, request, paths, events, status)
                atomic_json(directory / "project.json", project)
                atomic_json(directory / "request.json", request)
                status.finish(project)
                report["results"].append({"filename": song.name, "split": split, "sourceStartSeconds": start, "jobId": job_id, "projectPath": str(directory / "project.json"), "rawProjectPath": str(directory / "raw-project.json"), "tempoBefore": raw["tempo"], "tempoAfter": project["tempo"], "before": note_quality(raw["parts"]), "after": note_quality(project["parts"]), "analysis": project["source"]["analysis"], "groundTruthAvailable": False})
            except Exception as error:
                status.fail(str(error))
                report["results"].append({"filename": song.name, "split": split, "jobId": job_id, "error": str(error)})
                raise
            finally:
                atomic_json(args.output, report)
    for song, original in zip(songs, report["inputs"]):
        assert sha256(song) == original["sha256"], "Original user recording changed during validation"
    report["originalRecordingsUnchanged"] = True
    atomic_json(args.output, report)
    print(args.output)


if __name__ == "__main__":
    main()

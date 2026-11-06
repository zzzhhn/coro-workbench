#!/usr/bin/env python3
"""Evaluate an explicitly predeclared Vocadito split; never runs a model."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from server.vocal_groundtruth import align_f0_tracks, evaluate_note_annotators, f0_metrics, load_reference_f0, load_reference_notes, note_metrics, validate_notes

F0_KEYS = ("overallAccuracy", "voicingRecall", "voicingFalseAlarm", "rawPitchAccuracy", "rawChromaAccuracy")


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def resolved(path, base):
    path = Path(path)
    return path.resolve() if path.is_absolute() else (base / path).resolve()


def prediction_notes(path):
    data = json.loads(Path(path).read_text())
    if not isinstance(data, dict) or data.get("pitchUnit") not in {"midi", "hz"} or "events" not in data:
        raise ValueError("Prediction notes require explicit pitchUnit:midi|hz and events")
    if not data["events"]:
        return np.empty((0, 3))
    notes = np.asarray(data["events"], dtype=float)
    if notes.ndim != 2 or notes.shape[1] < 3:
        raise ValueError("Prediction events need onset,offset,pitch rows")
    notes = notes[:, :3].copy()
    if data["pitchUnit"] == "midi":
        notes[:, 2] = 440 * 2 ** ((notes[:, 2] - 69) / 12)
    return validate_notes(notes)


def note_summary(result):
    return {key: value for key, value in result.items() if key != "matchedPairs"}


def select_evaluation_ids(benchmark, protocol, split):
    """Selection comes only from the declared split, never prediction contents."""
    all_ids = sorted(track["id"] for track in benchmark["tracks"])
    pilot = benchmark["pilotIds"]
    if len(all_ids) != 40 or len(set(all_ids)) != 40 or all_ids[:8] != pilot:
        raise ValueError("Dataset manifest does not preserve the original lexicographic pilot")
    if split == "pilot":
        if protocol.get("pilotIds") != pilot:
            raise ValueError("Pilot protocol differs from the original manifest")
        return list(pilot)
    if split != "holdout" or protocol.get("evaluationSplit") != "holdout":
        raise ValueError("Holdout requires its own explicit holdout protocol")
    selected = protocol.get("evaluationIds")
    if not isinstance(selected, list) or len(selected) != 32 or len(set(selected)) != 32:
        raise ValueError("Holdout protocol must predeclare32 unique IDs")
    expected = set(all_ids) - set(pilot)
    if set(selected) != expected or set(protocol.get("excludedPilotIds", [])) != set(pilot):
        raise ValueError("Holdout must be exactly the32 originally reserved records, excluding all pilot IDs")
    return list(selected)


def validate_split_outputs(split, output, private):
    """A holdout evaluation cannot overwrite a pilot summary or private folder."""
    output, private = output.resolve(), private.resolve()
    if not private.is_relative_to(ROOT / "data"):
        raise ValueError("Aligned arrays and matches must stay under ignored data/")
    if split == "holdout":
        if output in {ROOT / "evidence/phase4/vocadito-evaluation-summary.json", ROOT / "evidence/phase4/vocadito-evaluation-summary.md", ROOT / "evidence/phase4/vocadito-protocol.json", ROOT / "evidence/phase4/vocadito-decoders.json"}:
            raise ValueError("Holdout output would overwrite protected pilot evidence")
        for pilot_private in (ROOT / "data/phase4/vocadito-evaluation", ROOT / "data/phase4/vocadito-pilot"):
            if private == pilot_private or private.is_relative_to(pilot_private) or pilot_private.is_relative_to(private):
                raise ValueError("Holdout private output must be independent of pilot directories")


def aggregate(rows):
    counts = {key: sum(row["f0"]["counts"][key] for row in rows) for key in rows[0]["f0"]["counts"]}
    ratio = lambda a, b: a / b if b else None
    macro = {key: float(np.mean([row["f0"][key] for row in rows if row["f0"][key] is not None])) if any(row["f0"][key] is not None for row in rows) else None for key in F0_KEYS}
    micro = {"overallAccuracy": ratio(counts["overallCorrect"], counts["frames"]), "voicingRecall": ratio(counts["voicingTruePositive"], counts["referenceVoiced"]), "voicingFalseAlarm": ratio(counts["voicingFalsePositive"], counts["referenceUnvoiced"]), "rawPitchAccuracy": ratio(counts["rawPitchCorrect"], counts["referenceVoiced"]), "rawChromaAccuracy": ratio(counts["rawChromaCorrect"], counts["referenceVoiced"])}
    notes = {}
    for annotator in ("A1", "A2"):
        notes[annotator] = {}
        for mode in ("onsetPitch", "onsetOffsetPitch"):
            values = [row["notes"][annotator][mode] for row in rows]
            ref = sum(value["referenceNotes"] for value in values)
            est = sum(value["estimatedNotes"] for value in values)
            matched = sum(value["matchedNotes"] for value in values)
            notes[annotator][mode] = {"referenceNotes": ref, "estimatedNotes": est, "matchedNotes": matched, "microPrecision": ratio(matched, est), "microRecall": ratio(matched, ref), "microF1": ratio(2 * matched, ref + est), "macroF1": float(np.mean([value["f1"] for value in values if value["f1"] is not None])) if any(value["f1"] is not None for value in values) else None}
    return {"tracks": len(rows), "f0": {"macro": macro, "micro": micro, "counts": counts}, "notes": notes, "minimumTrackOverallAccuracy": min(row["f0"]["overallAccuracy"] for row in rows)}


def markdown_report(report, destination):
    pct = lambda value: "undefined" if value is None else f"{value * 100:.2f}%"
    holdout = report.get("evaluationSplit") == "holdout"
    title = "Vocadito32-record predeclared holdout" if holdout else "Vocadito eight-record human-reference pilot"
    scope = "All32 originally reserved records are evaluated under the separate predeclared holdout protocol. No pilot record is included." if holdout else "IDs were chosen by lexicographic string order before inference. The other32 records were unscored at the pilot checkpoint."
    lines = ["# " + title, "", "This is a fixed local regression evaluation, not a final model ranking. " + scope + " Training overlap is unknown. F0 is a musician-corrected pYIN/Tony reference; note A1 and A2 remain separate interpretations.", "", "| Model | Macro overall | Voicing recall | False alarm | Raw pitch | Raw chroma |", "|---|---:|---:|---:|---:|---:|"]
    for name, model in report["models"].items():
        macro = model["aggregate"]["f0"]["macro"]
        lines.append("| " + name + " | " + " | ".join(pct(macro[key]) for key in F0_KEYS) + " |")
    lines += ["", "| Model | Annotator | Onset+pitch macroF1 | Onset+offset+pitch macroF1 |", "|---|---|---:|---:|"]
    for name, model in report["models"].items():
        for annotator in ("A1", "A2"):
            notes = model["aggregate"]["notes"][annotator]
            lines.append(f'| {name} | {annotator} | {pct(notes["onsetPitch"]["macroF1"])} | {pct(notes["onsetOffsetPitch"]["macroF1"])} |')
    lines += ["", "Raw pitch/chroma retain a supplied unvoiced pitch hypothesis; overall accuracy additionally requires the voicing decision to be correct. No best timing shift, octave repair, or best-annotator selection is applied. Undefined denominators stay null. All results use a10ms grid over the original audio duration; interpolation never crosses reference zero-F0 cells or large missing-time gaps.", "", "Per-track counts and micro aggregation are in the JSON summary. Matching pairs and aligned arrays stay in ignored data/. The evaluator runs no models and changes no source/F0 defaults.", "", "Sources: [Zenodo record](https://zenodo.org/records/5578807), [original report](https://arxiv.org/pdf/2110.05580), [metric conventions](https://github.com/craffel/mir_eval).", ""]
    destination.write_text("\n".join(lines), encoding="utf-8")


def run(args):
    if args.protocol is None:
        args.protocol = ROOT / ("evidence/phase4/vocadito-holdout-protocol.json" if args.evaluation_split == "holdout" else "evidence/phase4/vocadito-protocol.json")
    benchmark = json.loads(args.benchmark_manifest.read_text())
    protocol = json.loads(args.protocol.read_text())
    pilot = select_evaluation_ids(benchmark, protocol, args.evaluation_split)
    if args.evaluation_split == "holdout":
        original_protocol = ROOT / "evidence/phase4/vocadito-protocol.json"
        if protocol.get("parentPilotProtocolSha256") != digest(original_protocol):
            raise ValueError("Holdout protocol does not preserve the frozen pilot protocol hash")
        if protocol.get("scoring") != json.loads(original_protocol.read_text())["scoring"]:
            raise ValueError("Holdout scoring differs from frozen pilot thresholds/alignment")
        for source_path, expected in protocol.get("sourceSha256", {}).items():
            if digest(ROOT / source_path) != expected:
                raise ValueError(f"Frozen holdout source changed: {source_path}")
    if args.output is None:
        args.output = ROOT / protocol.get("output", "evidence/phase4/vocadito-holdout-evaluation.json") if args.evaluation_split == "holdout" else ROOT / "evidence/phase4/vocadito-evaluation-summary.json"
    if args.private_output is None:
        args.private_output = ROOT / protocol.get("privateOutput", "data/phase4/vocadito-holdout") if args.evaluation_split == "holdout" else ROOT / "data/phase4/vocadito-evaluation"
    validate_split_outputs(args.evaluation_split, args.output, args.private_output)
    root = Path(benchmark["datasetRoot"])
    tracks = {track["id"]: dict(track) for track in benchmark["tracks"] if track["id"] in pilot}
    if args.evaluation_split == "holdout":
        import soundfile as sf
        for track in tracks.values():
            info = sf.info(resolved(track["audio"], root))
            track.update(durationSeconds=info.duration, sampleRate=info.samplerate, samples=info.frames)
    references = {}
    manifest = []
    for track_id in pilot:
        track = tracks[track_id]
        f0_path, notes1_path, notes2_path = (resolved(track[key], root) for key in ("f0", "notes1", "notes2"))
        ref_time, ref_f0 = load_reference_f0(f0_path)
        notes1, notes2 = load_reference_notes(notes1_path), load_reference_notes(notes2_path)
        references[track_id] = (ref_time, ref_f0, notes1, notes2)
        manifest.append({"id": track_id, "audioDurationSeconds": track["durationSeconds"], "f0Frames": len(ref_time), "observedF0HopSeconds": float(np.median(np.diff(ref_time))), "notesA1": len(notes1), "notesA2": len(notes2), "annotationSha256": {key: digest(path) for key, path in (("f0", f0_path), ("notes1", notes1_path), ("notes2", notes2_path))}})
    report = {"schemaVersion": 1, "dataset": "vocadito", "recordId": 5578807, "evaluationSplit": args.evaluation_split, "evaluationIds": pilot, "trainOverlap": "unknown", "protocolSha256": digest(args.protocol), "benchmarkManifestSha256": digest(args.benchmark_manifest), "sourceSha256": {"checker": digest(ROOT / "server/vocal_groundtruth.py"), "evaluator": digest(Path(__file__))}, "models": {}, "neuralInferenceByEvaluator": False, "alignment": protocol["scoring"]["referenceResampling"], "noteAnnotatorPolicy": "A1/A2 separately; no per-track best-reference selection"}
    if args.evaluation_split == "pilot":
        report.update(pilotIds=pilot, reservedIdsNotScored=protocol["reservedIds"], referenceInventoryPilotOnly=manifest)
    else:
        report.update(excludedPilotIds=benchmark["pilotIds"], referenceInventoryHoldoutOnly=manifest)
    if args.predictions_manifest is None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({"status": "reference preflight only; no model scoring", "evaluationSplit": args.evaluation_split, "evaluationIds": pilot, "referenceTracksRead": len(references)}))
        return
    predictions = json.loads(args.predictions_manifest.read_text())
    models = predictions.get("models")
    if not isinstance(models, dict) or not models:
        raise ValueError("Predictions manifest needs models.{model}.{trackId}")
    if args.evaluation_split == "holdout" and set(models) != set(protocol.get("models", [])):
        raise ValueError("Holdout prediction models differ from the frozen protocol")
    private = args.private_output.resolve()
    if not private.is_relative_to(ROOT / "data"):
        raise ValueError("Aligned arrays and matching pairs must stay under ignored data/")
    private.mkdir(parents=True, exist_ok=True)
    report["predictionManifestSha256"] = digest(args.predictions_manifest)
    for name, entries in models.items():
        if not re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9_.-]*", name) or name in {".", ".."}:
            raise ValueError("Unsafe model directory name")
        if set(entries) != set(pilot):
            raise ValueError(f"{name}: require exactly the{len(pilot)} predeclared {args.evaluation_split} IDs; no missing/extra IDs")
        destination = private / name
        destination.mkdir(exist_ok=True)
        rows = []
        for track_id in pilot:
            entry = entries[track_id]
            contour_path = resolved(entry.get("f0", entry.get("contour")), args.predictions_manifest.parent)
            note_path = resolved(entry["notes"], args.predictions_manifest.parent)
            with np.load(contour_path) as values:
                predicted_time, predicted_f0 = values["time"].copy(), values["f0"].copy()
                predicted_voice = values["voicing"].copy() if "voicing" in values.files else None
            estimated_notes = prediction_notes(note_path)
            ref_time, ref_f0, notes1, notes2 = references[track_id]
            duration = tracks[track_id]["durationSeconds"]
            grid, ref, ref_voice, est, est_voice = align_f0_tracks(ref_time, ref_f0, predicted_time, predicted_f0, duration_seconds=duration, hop_seconds=.01, estimated_voicing=predicted_voice)
            f0 = f0_metrics(ref, est, reference_voicing=ref_voice, estimated_voicing=est_voice)
            notes = evaluate_note_annotators(notes1, notes2, estimated_notes)
            private_notes = destination / f"{track_id}-note-matches.json"
            private_notes.write_text(json.dumps(notes, indent=2) + "\n")
            np.savez_compressed(destination / f"{track_id}-aligned.npz", time=grid, referenceF0=ref, referenceVoicing=ref_voice, estimatedF0=est, estimatedVoicing=est_voice)
            public_notes = {annotator: {mode: note_summary(result) for mode, result in modes.items()} for annotator, modes in notes.items()}
            row = {"id": track_id, "durationSeconds": duration, "f0": f0, "notes": public_notes, "predictionSha256": {"contour": digest(contour_path), "notes": digest(note_path)}}
            rows.append(row)
        report["models"][name] = {"rows": rows, "aggregate": aggregate(rows)}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    markdown_report(report, args.output.with_suffix(".md"))
    print(json.dumps({"output": str(args.output), "evaluationSplit": args.evaluation_split, "evaluationIds": pilot, "models": {name: model["aggregate"] for name, model in report["models"].items()}}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--benchmark-manifest", type=Path, default=ROOT / "data/benchmarks/vocadito/manifest.json")
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--evaluation-split", choices=("pilot", "holdout"), default="pilot")
    selection.add_argument("--holdout", action="store_const", const="holdout", dest="evaluation_split", default=argparse.SUPPRESS, help="Alias for --evaluation-split holdout; all explicit protocol/ID guards still apply")
    parser.add_argument("--protocol", type=Path)
    parser.add_argument("--predictions-manifest", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--private-output", type=Path)
    run(parser.parse_args())

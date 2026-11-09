#!/usr/bin/env python3
"""Private eight-clip SSVD experiments: prepare, infer, then score frozen output.

No production defaults change. Labels are downloaded by prepare, but infer never
parses or opens them. This is a small development diagnostic, not a blinded
mixed-song benchmark. Dataset redistribution permission has not been established.

--split diagnostic now uses data/p0-vocal/bounded-diagnostic; --split validation
uses data/p0-vocal/validation. The original data/p0-vocal protocol remains
available with --legacy-protocol, and is never migrated or overwritten.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import re
import sys
import time
import urllib.request

# Set before numpy/torch/ORT imports; inference also sets their runtime limits.
for _name in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMBA_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
    os.environ[_name] = "1"
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
PRIVATE_ROOT = ROOT / "data/p0-vocal"
PRIVATE = PRIVATE_ROOT
SPLIT = "diagnostic"
BOUNDED = False  # Preserve the original protocol for existing import callers.
COMMIT = "93d36acd28cc46a53cd698260c0df459ec399056"
IDS = ("100135", "100144", "100270", "100388", "100400", "100620", "100946", "101520")
# Sizes and Git blob IDs from the official repository tree at COMMIT.
FILES = {
    '100135.flac': (1514018, '75f063c99089dd8168572683dfe7808145691533'),
    '100135.txt': (848, '1f7450a81d21a86c176d41377642eb7a15ebbc64'),
    '100144.flac': (929824, 'fa28a6c9cb260c5f56804eef202268fd0609a562'),
    '100144.txt': (828, '9a141946ad231336e00126a31577ca334bf067e6'),
    '100270.flac': (1296220, '12103415515dd94193378ac72950bc7eee894d83'),
    '100270.txt': (695, '010d32657dd170187b102c694d94cc2844f93c23'),
    '100388.flac': (1191272, '7fcfd8f3ce7f10d18da43355e77d33521ca1ef9a'),
    '100388.txt': (587, 'e481e7b233da9cb5a954a51be6e2270c0244d62b'),
    '100400.flac': (2131758, '120c85ee18d13574156ba744f31a1a9fc4a83fbf'),
    '100400.txt': (838, '7e62a71c98d66e8975a53712a4cb137f4425ca87'),
    '100620.flac': (571661, '95ae54884f1086fcddb12a3ffa47b211b1329c4e'),
    '100620.txt': (833, 'f851cdd605f60257295605b32a75b1f428534e66'),
    '100946.flac': (1714592, '03e80bf8f95b71b0d2fd094878b99d80c8801c91'),
    '100946.txt': (762, 'c0eaf0a3272730acd5d2838a8f3dc86629c507c9'),
    '101520.flac': (1201533, 'dc7b3d4611d17222bfe18f558a4a5e54569f24c3'),
    '101520.txt': (493, '4ae03560b0df185ceaf4a85abf240b98a6a823c2'),
}
DIAGNOSTIC_IDS = IDS
DIAGNOSTIC_FILES = FILES
VALIDATION_IDS = ("101550", "101552", "101666", "101696", "101697", "101763", "101806", "101813")
VALIDATION_FILES = {
    '101550.flac': (1375135, '7a473ed4ca95b9fa550a1e2a713e6bef780a9f9e'),
    '101550.txt': (852, '001195ae1944a7d98ff55c543b70d75ad92a3fc7'),
    '101552.flac': (1042794, 'b088ebff36e52b609d9842953298ed9034cfd97d'),
    '101552.txt': (496, '59fdc83430e856df637819dc08d019a45934d250'),
    '101666.flac': (2589145, 'd3c9826185597675867a2fab5596fd409ad8a2ee'),
    '101666.txt': (1136, 'd3f9006f4d557788fb5ebc34d5e582fdbfde4d90'),
    '101696.flac': (1330652, '51bc9270adbe5e8549dd25a1480dcd5cce55354e'),
    '101696.txt': (499, '8aede0c4d6482f92ed9a460ef999285665bb1d09'),
    '101697.flac': (2639179, '0a11b0517e6316c84d15b25562cce5e4bf11e3c4'),
    '101697.txt': (1220, 'fe0cf43e978ac6732c621a6ee7b5429c9bc18f86'),
    '101763.flac': (2302519, '87308318e9658fb1e7fa0ff3ebfd37a25a7fe053'),
    '101763.txt': (1110, 'f94cc1e3142fa7d5900d852234d028d2ac4cd028'),
    '101806.flac': (754783, '48aaea99a88345ae8137ec991fd9adcafd9f8824'),
    '101806.txt': (232, '902eb874b74c83924277c34b48c40d015cd2d550'),
    '101813.flac': (990937, 'b42b51645cebafc1d079f4804fb29414cf8b36c5'),
    '101813.txt': (601, '252f1f505b276388a2de726c5872dbe047225ada'),
}


def configure_split(name, *, bounded=True):
    """Configure import callers without touching files, labels or model weights."""
    if name not in {"diagnostic", "validation"} or (name == "validation" and not bounded):
        raise ValueError("Choose diagnostic or validation; legacy protocol is diagnostic only")
    global IDS, FILES, PRIVATE, SPLIT, BOUNDED
    SPLIT, BOUNDED = name, bounded
    IDS, FILES = (DIAGNOSTIC_IDS, DIAGNOSTIC_FILES) if name == "diagnostic" else (VALIDATION_IDS, VALIDATION_FILES)
    PRIVATE = PRIVATE_ROOT / ("validation" if name == "validation" else "bounded-diagnostic") if bounded else PRIVATE_ROOT
    return PRIVATE


def sha256(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text())


def write_once(path, value):
    """Exact reruns are harmless; conflicting evidence is never replaced."""
    path = Path(path)
    content = json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n"
    if path.exists():
        if path.read_text() != content:
            raise ValueError(f"Refusing to overwrite conflicting evidence: {path}")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x") as stream:
        stream.write(content)


def protocol():
    result = {"schemaVersion": 1, "dataset": "SSVD-v2.0", "upstreamCommit": COMMIT,
            "source": "https://github.com/xk-wang/SSVD-v2.0", "ids": list(IDS),
            "selection": "first eight lexicographic official test IDs; diagnostic only",
            "files": {name: {"bytes": size, "gitBlobSha1": blob} for name, (size, blob) in FILES.items()},
            "license": "No explicit dataset license found; keep audio and labels private",
            "pitchReference": "continuous MIDI converted to Hz without rounding",
            "scoring": {"onsetSeconds": .05, "pitchCents": 50, "offsetRatio": .2, "minimumOffsetSeconds": .05,
                        "referenceTimingShiftSeconds": 0, "referenceOctaveRepair": False},
            "grid": "librosa audio-only beat_track, fit_beat_grid; insufficient support uses explicit 120 BPM phase-zero fallback",
            "profiles": ["standard", "acoustic"],
            "legacyQuantizer": {"monophonic": True, "quantumBeats": .125,
                                "reason": "Existing production audio_quality monophonic vocal path uses a 32nd-note grid"},
            "productionDefaultsChanged": False}
    if BOUNDED:
        result.update({"schemaVersion": 2, "evaluationSplit": SPLIT,
                       "variants": ["raw", "legacy_grid", "joint_rhythm", "bounded_rhythm"],
                       "boundedQuantizer": {"timingToleranceSeconds": .025,
                                            "method": "quantize_vocal_rhythm timing_tolerance_seconds; retain old unbounded joint variant separately"}})
        if SPLIT == "validation":
            result["selection"] = "next eight lexicographic official test IDs after diagnostic eight; no overlap; selected from pinned Git metadata without audio or label access"
    return result


def check_protocol(directory):
    if read_json(directory / "protocol.json") != protocol():
        raise ValueError("Existing protocol conflicts with this frozen experiment")


def prepare(directory):
    write_once(directory / "protocol.json", protocol())
    downloaded = {}
    for name, (size, blob) in FILES.items():
        path = directory / "dataset" / name
        if not path.exists():
            url = f"https://raw.githubusercontent.com/xk-wang/SSVD-v2.0/{COMMIT}/test/{name}"
            with urllib.request.urlopen(url, timeout=60) as response:
                data = response.read(size + 1)
            if len(data) != size or hashlib.sha1(f"blob {size}\0".encode() + data).hexdigest() != blob:
                raise ValueError(f"Upstream content differs from pinned Git blob: {name}")
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("xb") as stream:
                stream.write(data)
        # Verify resumed files against the pinned upstream blob, never adopt local edits.
        data = path.read_bytes()
        if len(data) != size or hashlib.sha1(f"blob {size}\0".encode() + data).hexdigest() != blob:
            raise ValueError(f"Conflicting dataset file: {name}")
        downloaded[name] = {"bytes": size, "sha256": hashlib.sha256(data).hexdigest()}
    write_once(directory / "dataset-manifest.json", {"commit": COMMIT, "files": downloaded})
    print(f"Prepared {len(IDS)} clips and labels in {directory}; redistribution permission unknown")


def verify_files(base, hashes):
    for name, expected in hashes.items():
        if sha256(base / name) != expected:
            raise ValueError(f"Frozen file changed: {name}")


def source_hashes():
    paths = [Path(__file__), *sorted((ROOT / "server").glob("*.py"))]
    return {str(path.relative_to(ROOT)): sha256(path) for path in paths}


def model_hashes(basic_pitch):
    import torchfcpe
    paths = sorted(Path(torchfcpe.__file__).parent.rglob("*.pt"))
    if not paths:
        raise ValueError("Official bundled FCPE checkpoint not found")
    if basic_pitch:
        from basic_pitch import build_icassp_2022_model_path, FilenameSuffix
        paths.append(build_icassp_2022_model_path(FilenameSuffix.onnx))
    return {str(path.resolve()): sha256(path) for path in paths}


def estimate_grid(audio, sr):
    import librosa
    import numpy as np
    from server.rhythm import fit_beat_grid
    tempo, beats = librosa.beat.beat_track(y=audio, sr=sr, hop_length=256, trim=False)
    bpm = float(np.ravel(tempo)[0])
    supported = math.isfinite(bpm) and 30 <= bpm <= 240 and len(beats) >= 3
    fallback = bpm if supported else 120.
    seconds = librosa.frames_to_time(beats, sr=sr, hop_length=256)
    grid = fit_beat_grid(seconds, np.empty(0), fallback)
    fitted = not grid["method"].startswith("constant-grid fallback")
    grid["method"] = "librosa audio-only beat_track + robust phase fit" if fitted else "librosa audio-only tempo; phase zero (insufficient phase support)" if supported else "insufficient audio beat evidence; explicit 120 BPM phase-zero fallback"
    grid["audioOnly"] = True
    return grid


def notes_to_events(notes, grid):
    spb, offset = 60 / grid["bpm"], grid["offsetSeconds"]
    return [[offset + n["start"] * spb, offset + (n["start"] + n["duration"]) * spb,
             n["midi"], n.get("confidence", n.get("velocity", 1.))] for n in notes if n["midi"] is not None]


def quantized_variants(events, grid, duration):
    from server.rhythm import quantize_on_grid
    from server.vocal_score import quantize_vocal_rhythm
    # Match audio_quality's existing monophonic vocal path: eighth of a beat,
    # i.e. a 32nd note, rather than quantize_on_grid's generic .25 default.
    legacy = quantize_on_grid(events, grid, duration, "vocals", monophonic=True, quantum=.125)
    joint, audit = quantize_vocal_rhythm(events, grid, duration)
    quantized = [("legacy_grid", legacy), ("joint_rhythm", joint)]
    if BOUNDED:
        bounded, bounded_audit = quantize_vocal_rhythm(events, grid, duration, timing_tolerance_seconds=.025)
        quantized.append(("bounded_rhythm", bounded))
    result = {"raw": {"events": events, "inputNotes": len(events), "outputNotes": len(events), "droppedNotes": 0}}
    for label, notes in quantized:
        converted = notes_to_events(notes, grid)
        result[label] = {"events": converted, "inputNotes": len(events), "outputNotes": len(notes),
                         "droppedNotes": len(events) - len(notes)}
        if len(events) == len(converted):
            result[label]["maximumOnsetShiftSeconds"] = max((abs(a[0] - b[0]) for a, b in zip(events, converted)), default=0.)
            result[label]["maximumOffsetShiftSeconds"] = max((abs(a[1] - b[1]) for a, b in zip(events, converted)), default=0.)
        else:
            result[label]["maximumOnsetShiftSeconds"] = None
            result[label]["maximumOffsetShiftSeconds"] = None
    result["joint_rhythm"]["audit"] = audit
    if BOUNDED:
        result["bounded_rhythm"]["audit"] = bounded_audit
    return result


def basic_pitch_model():
    # Reuse the official wrapper/predict path, with an explicitly bounded ORT session.
    import onnxruntime as ort
    from basic_pitch import build_icassp_2022_model_path, FilenameSuffix
    from basic_pitch.inference import Model
    options = ort.SessionOptions()
    options.intra_op_num_threads = options.inter_op_num_threads = 1
    model = Model.__new__(Model)
    model.model_type = Model.MODEL_TYPES.ONNX
    model.model = ort.InferenceSession(str(build_icassp_2022_model_path(FilenameSuffix.onnx)),
                                      sess_options=options, providers=["CPUExecutionProvider"])
    return model


def infer(directory, run_name, include_basic_pitch=False):
    check_protocol(directory)
    manifest = read_json(directory / "dataset-manifest.json")
    # Labels are intentionally not opened in this stage, even for hash checking.
    verify_files(directory / "dataset", {n: v["sha256"] for n, v in manifest["files"].items() if n.endswith(".flac")})
    run = directory / "runs" / run_name
    run.mkdir(parents=True, exist_ok=False)
    import numpy as np
    import torch
    from torchfcpe import spawn_bundled_infer_model
    from server.quality_runner import extract_f0, mono_audio
    from server.vocal_decode import decode_selected_contour
    if importlib.metadata.version("torchfcpe") != "0.0.4":
        raise ValueError("This protocol requires official torchfcpe==0.0.4")
    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    before_sources, before_models = source_hashes(), model_hashes(include_basic_pitch)
    frozen = {"protocolSha256": sha256(directory / "protocol.json"),
              "datasetManifestSha256": sha256(directory / "dataset-manifest.json"),
              "sources": before_sources, "models": before_models, "basicPitch": include_basic_pitch,
              "cpuThreads": 1, "device": "cpu", "referenceRead": False,
              "versions": {name: importlib.metadata.version(name) for name in
                           ("numpy", "scipy", "torch", "torchaudio", "torchfcpe", "librosa")}}
    if include_basic_pitch:
        frozen["versions"].update({name: importlib.metadata.version(name) for name in ("basic-pitch", "onnxruntime")})
    write_once(run / "inference-plan.json", frozen)
    model = spawn_bundled_infer_model(device="cpu")
    bp_model = basic_pitch_model() if include_basic_pitch else None
    predictions = {}
    for identifier in IDS:
        started = time.perf_counter()
        path = directory / "dataset" / f"{identifier}.flac"
        audio, sr = mono_audio(path)
        duration = len(audio) / sr
        grid = estimate_grid(audio, sr)
        contour_path = run / f"{identifier}-fcpe.npz"
        began_f0 = time.perf_counter()
        f0_info = extract_f0(path, contour_path, model)
        f0_seconds = time.perf_counter() - began_f0
        track = {"durationSeconds": duration, "grid": grid, "fcpe": f0_info,
                 "f0RuntimeSeconds": f0_seconds, "variants": {}}
        with np.load(contour_path, allow_pickle=False) as contour:
            for profile in ("standard", "acoustic"):
                began = time.perf_counter()
                events, info = decode_selected_contour(contour["time"], contour["f0"], contour["activation"], audio, sr, profile=profile)
                variants = quantized_variants(events, grid, duration)
                for label, value in variants.items():
                    track["variants"][f"fcpe_{profile}/{label}"] = value
                track[profile] = {"decoder": info, "decodeAndQuantizeRuntimeSeconds": time.perf_counter() - began}
        if include_basic_pitch:
            from server.pipeline import transcribe
            began = time.perf_counter()
            _, raw = transcribe(path, bp_model, grid["bpm"], duration, "vocals")
            # BasicPitch is polyphonic; do not silently force it through a mono quantizer.
            track["variants"]["basic_pitch/raw"] = {"events": raw, "inputNotes": len(raw), "outputNotes": len(raw), "droppedNotes": 0}
            track["basicPitchRuntimeSeconds"] = time.perf_counter() - began
        track["runtimeSeconds"] = time.perf_counter() - started
        predictions[identifier] = track
        print(f"Inferred {identifier} in {track['runtimeSeconds']:.2f}s", flush=True)
    if source_hashes() != before_sources or model_hashes(include_basic_pitch) != before_models:
        raise ValueError("Code or weights changed during inference; refusing to freeze")
    write_once(run / "predictions.json", {"pitchUnit": "midi", "tracks": predictions})
    artifacts = {p.name: sha256(p) for p in sorted(run.iterdir()) if p.is_file()}
    write_once(run / "frozen.json", {**frozen, "artifacts": artifacts, "predictionsFrozenBeforeLabelParsing": True})
    print(f"Frozen predictions: {run / 'frozen.json'}")


def parse_reference(path):
    import numpy as np
    from server.vocal_groundtruth import validate_notes
    rows = np.asarray(np.loadtxt(path, ndmin=2), dtype=float)
    if rows.shape[1] != 3 or not np.isfinite(rows).all() or np.any((rows[:, 2] < 0) | (rows[:, 2] > 127)):
        raise ValueError("SSVD labels must be onset, offset, continuous MIDI")
    rows[:, 2] = 440 * 2 ** ((rows[:, 2] - 69) / 12)
    return validate_notes(rows)


def aggregate_metrics(rows):
    counts = {key: sum(row[key] for row in rows) for key in ("matchedNotes", "referenceNotes", "estimatedNotes")}
    matched, reference, estimated = (counts[key] for key in ("matchedNotes", "referenceNotes", "estimatedNotes"))
    def ratio(a, b):
        return a / b if b else None
    valid = [row["f1"] for row in rows if row["f1"] is not None]
    return {**counts, "microPrecision": ratio(matched, estimated), "microRecall": ratio(matched, reference),
            "microF1": ratio(2 * matched, reference + estimated), "macroF1": sum(valid) / len(valid) if valid else None}


def verify_frozen(directory, run):
    check_protocol(directory)
    frozen = read_json(run / "frozen.json")  # Must exist before any human-label access.
    if frozen.get("predictionsFrozenBeforeLabelParsing") is not True:
        raise ValueError("Predictions were not frozen before label parsing")
    if sha256(directory / "protocol.json") != frozen["protocolSha256"] or sha256(directory / "dataset-manifest.json") != frozen["datasetManifestSha256"]:
        raise ValueError("Protocol or dataset manifest changed after inference")
    verify_files(run, frozen["artifacts"])
    verify_files(ROOT, frozen["sources"])
    verify_files(Path("/"), frozen["models"])
    return frozen


def score(directory, run_name):
    import numpy as np
    from server.vocal_groundtruth import note_metrics, validate_notes
    run = directory / "runs" / run_name
    frozen = verify_frozen(directory, run)
    manifest = read_json(directory / "dataset-manifest.json")
    verify_files(directory / "dataset", {name: item["sha256"] for name, item in manifest["files"].items()})
    predictions = read_json(run / "predictions.json")["tracks"]
    report = {"dataset": f"SSVD-v2.0 eight-clip {SPLIT}", "ids": list(IDS), "upstreamCommit": COMMIT,
              "frozenSha256": sha256(run / "frozen.json"), "scoring": protocol()["scoring"],
              "limits": ["Development diagnostic; training overlap unknown", "Solo sight-singing does not validate mixed-song lead identity",
                         "Dataset license not clarified; raw data and per-note outputs remain private", "No reference-based delay, pitch repair or threshold search"],
              "perTrack": {}, "aggregate": {}, "versions": frozen["versions"]}
    grouped = {}
    for identifier in IDS:
        reference = parse_reference(directory / "dataset" / f"{identifier}.txt")
        track = predictions[identifier]
        report["perTrack"][identifier] = {key: track[key] for key in
                                          ("durationSeconds", "grid", "runtimeSeconds", "f0RuntimeSeconds")}
        report["perTrack"][identifier]["variants"] = {}
        for variant, output in predictions[identifier]["variants"].items():
            events = np.asarray(output["events"], dtype=float)
            estimate = events[:, :3].copy() if events.size else np.empty((0, 3))
            estimate[:, 2] = 440 * 2 ** ((estimate[:, 2] - 69) / 12)
            estimate = validate_notes(estimate)
            metrics = {}
            for mode, require_offset in (("onsetPitch", False), ("onsetOffsetPitch", True)):
                result = note_metrics(reference, estimate, require_offset=require_offset)
                metrics[mode] = {key: value for key, value in result.items() if key != "matchedPairs"}
                grouped.setdefault((variant, mode), []).append(metrics[mode])
            report["perTrack"][identifier]["variants"][variant] = {**metrics, **{key: value for key, value in output.items() if key not in ("events", "audit")}}
    for (variant, mode), rows in grouped.items():
        report["aggregate"].setdefault(variant, {})[mode] = aggregate_metrics(rows)
    write_once(run / "scores.json", report)
    print(json.dumps(report["aggregate"], indent=2, allow_nan=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("prepare", "infer", "score"))
    parser.add_argument("--split", choices=("diagnostic", "validation"), default="diagnostic")
    parser.add_argument("--legacy-protocol", action="store_true", help="Use the unchanged original diagnostic protocol and directory")
    parser.add_argument("--directory", type=Path)
    parser.add_argument("--run", default="baseline-v1")
    parser.add_argument("--basic-pitch", action="store_true")
    args = parser.parse_args()
    if args.legacy_protocol and args.split != "diagnostic":
        parser.error("--legacy-protocol is only available for --split diagnostic")
    configure_split(args.split, bounded=not args.legacy_protocol)
    directory = (args.directory or PRIVATE).resolve()
    if directory != PRIVATE.resolve() and PRIVATE.resolve() not in directory.parents:
        parser.error(f"Keep this split under its private experiment directory: {PRIVATE}")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", args.run):
        parser.error("Run name must use ASCII letters, numbers, underscore or hyphen")
    if args.stage == "prepare":
        prepare(directory)
    elif args.stage == "infer":
        infer(directory, args.run, args.basic_pitch)
    else:
        score(directory, args.run)


if __name__ == "__main__":
    main()

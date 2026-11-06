"""Local inference for an explicit frozen split; no parameter search."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time

os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", WANDB_MODE="disabled")
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import numpy as np
import soundfile as sf
import torch

from server.quality_runner import extract_f0, mono_audio
from server.vocal import decode_vocal_contour
from server.voice_rescue import frame_rms, rms_floor


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", choices=["fcpe", "rmvpe"], required=True)
    parser.add_argument("--split", choices=["pilot", "holdout"], default="pilot")
    args = parser.parse_args()
    protocol = ROOT / ("evidence/phase4/vocadito-protocol.json" if args.split == "pilot" else "evidence/phase4/vocadito-holdout-protocol.json")
    if not protocol.is_file():
        raise RuntimeError("The pilot protocol must be frozen before inference")
    frozen = json.loads(protocol.read_text())
    dataset = ROOT / "data/benchmarks/vocadito"
    all_ids = sorted(path.stem.removeprefix("vocadito_") for path in (dataset / "Audio").glob("vocadito_*.wav"))
    ids = all_ids[:8] if args.split == "pilot" else all_ids[8:]
    assert len(ids) == (8 if args.split == "pilot" else 32)
    assert frozen["pilotIds" if args.split == "pilot" else "evaluationIds"] == ids, "Split identity mismatch"
    if args.split == "holdout":
        assert args.engine == "fcpe", "Only the selected FCPE decoder comparison is declared for holdout"
        for path, digest in frozen["sourceSha256"].items():
            assert sha(ROOT / path) == digest, f"Frozen source changed: {path}"
    output = ROOT / f"data/phase4/vocadito-{args.split}" / args.engine
    output.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(4)
    if args.engine == "fcpe":
        from torchfcpe import spawn_bundled_infer_model
        model = spawn_bundled_infer_model(device="cpu")
        model_info = {"name": "Existing bundled FCPE fcpe_c_v001", "rawDecoderThreshold": .006,
                      "activationThreshold": .03, "newWeightsDownloaded": False}
    else:
        assert tuple(map(int, torch.__version__.split("+")[0].split(".")[:2])) >= (2, 10)
        os.environ["TORCH_FORCE_WEIGHTS_ONLY_LOAD"] = "1"
        os.environ["RVC_CUDA_GRAPH"] = "0"
        refs = ROOT / "work/refs/rmvpe-review"
        weight = refs / "rmvpe.pt"
        assert weight.stat().st_size == 181184272
        assert sha(weight) == "6d62215f4306e3ca278246188607209f09af3dc77ed4232efdd069798c4ec193"
        review = json.loads((refs / "review-metadata.json").read_text())
        for name, path in [("rmvpe.py", refs / "rvc/infer/rmvpe.py"), ("cuda_graph.py", refs / "rvc/tools/cuda_graph.py")]:
            assert sha(path) == review["publicReferenceFiles"][name]
        sys.path.insert(0, str(refs / "rvc"))
        from infer.rmvpe import RMVPE
        model = RMVPE(str(weight), is_half=False, device="cpu")
        model_info = {"name": "RMVPE RVC", "threshold": .03, "weightSha256": sha(weight),
                      "sourceRevision": review["rvcRevision"], "weightsOnlyForced": True}
    manifest = {"engine": args.engine, "torchVersion": torch.__version__, "model": model_info,
                "protocolSha256": sha(protocol), "runnerSha256": sha(Path(__file__)), "evaluationIds": ids,
                "evaluationSplit": args.split,
                "defaultPipelineChanged": False, "rows": [],
                "scope": "Direct unaccompanied singing input; unquantized note decoding. Not a full mixture/separation/score benchmark."}
    for identifier in ids:
        path = dataset / "Audio" / f"vocadito_{identifier}.wav"
        before = sha(path)
        destination = output / identifier
        destination.mkdir(exist_ok=True)
        started = time.monotonic()
        audio, sr = mono_audio(path)
        contour_path = destination / "contour.npz"
        if args.engine == "fcpe":
            extract_f0(path, contour_path, model)
            with np.load(contour_path, allow_pickle=False) as stored:
                times, f0, activation = (stored[name] for name in ("time", "f0", "activation"))
        else:
            with torch.inference_mode():
                hidden = model.mel2hidden(model.extract_mel(audio)).squeeze(0).cpu().numpy()
            f0 = model.decode(hidden, thred=.03)
            activation = hidden.max(axis=-1)
            times = np.arange(len(f0)) * .01
            within = times < len(audio) / sr
            times, f0, activation = times[within], f0[within], activation[within]
        rms = frame_rms(times, audio, sr)
        voiced = np.isfinite(f0) & (f0 >= 55) & (f0 <= 1100) & (activation >= .03) & (rms >= rms_floor(rms))
        notes, details = decode_vocal_contour(times, f0, activation, audio, sr)
        np.savez_compressed(contour_path, time=times, f0=f0, activation=activation, voicing=voiced)
        notes_path = destination / "notes.json"
        notes_path.write_text(json.dumps({"events": notes, "pitchUnit": "midi", "decoder": details}) + "\n")
        assert sha(path) == before
        row = {"id": identifier, "audioSha256": before, "durationSeconds": sf.info(path).duration,
               "contour": str(contour_path.relative_to(ROOT)), "contourSha256": sha(contour_path),
               "notes": str(notes_path.relative_to(ROOT)), "notesSha256": sha(notes_path),
               "events": len(notes), "runtimeSeconds": round(time.monotonic() - started, 3)}
        manifest["rows"].append(row)
        (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        print(json.dumps({"engine": args.engine, "id": identifier, "events": len(notes), "seconds": row["runtimeSeconds"]}), flush=True)


if __name__ == "__main__":
    main()

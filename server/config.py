from __future__ import annotations

import importlib.metadata
import importlib.util
import os
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.environ.get("CORO_DATA_DIR", ROOT / "data")).resolve()
MODELS_DIR = Path(os.environ.get("CORO_MODELS_DIR", ROOT / "models")).resolve()
MAX_UPLOAD_BYTES = 100 * 1024 * 1024
MAX_DURATION_SECONDS = 600
MAX_ANALYSIS_SECONDS = 300
MAX_PENDING_JOBS = 4
DEMUCS_NAME = "htdemucs_6s"
DEMUCS_FILE = "5c90dfd2-34c22ccb.th"
ALLOWED_EXTENSIONS = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".opus", ".aif", ".aiff", ".mp4"}


def binary(name: str) -> str | None:
    found = shutil.which(name)
    local = Path.home() / ".local" / "bin" / name
    return found or (str(local) if local.is_file() else None)


def package_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def basic_pitch_path() -> Path | None:
    spec = importlib.util.find_spec("basic_pitch")
    if spec is None or not spec.origin:
        return None
    return Path(spec.origin).parent / "saved_models" / "icassp_2022" / "nmp.onnx"


def engine_health() -> dict:
    bp_path = basic_pitch_path()
    bp_version = package_version("basic-pitch")
    ort_version = package_version("onnxruntime")
    demucs_version = package_version("demucs")
    classifier_version = package_version("transformers")
    ast_ready = all((MODELS_DIR / "ast" / name).is_file() for name in ("config.json", "preprocessor_config.json", "model.safetensors"))
    yourmt3 = MODELS_DIR / "yourmt3"
    multi_ready = (yourmt3 / ".venv" / "bin" / "python").is_file() and (yourmt3 / "verified-manifest.json").is_file() and (yourmt3 / "model_helper.py").is_file() and (yourmt3 / "amt" / "logs" / "2024" / "mc13_256_g4_all_v7_mt3f_sqr_rms_moe_wf4_n8k2_silu_rope_rp_b36_nops" / "checkpoints" / "last.ckpt").is_file()
    quality_root = MODELS_DIR / "audio-quality"
    return {
        "basicPitch": {
            "ready": bool(bp_version and ort_version and bp_path and bp_path.is_file()),
            "version": bp_version,
            "runtime": f"ONNX Runtime {ort_version}" if ort_version else None,
            "model": "Spotify Basic Pitch ICASSP 2022",
        },
        "demucs": {
            "ready": bool(demucs_version and (MODELS_DIR / "torch" / "checkpoints" / DEMUCS_FILE).is_file()),
            "version": demucs_version,
            "model": DEMUCS_NAME,
            "sources": ["vocals", "drums", "bass", "guitar", "piano", "other"],
        },
        "instrumentClassifier": {
            "ready": bool(classifier_version and ast_ready),
            "model": "MIT AST AudioSet",
            "note": "Instrument-family suggestions, not separated orchestral parts or calibrated probabilities.",
        },
        "yourMT3": {
            "ready": multi_ready,
            "model": "YourMT3+ YPTF.MoE+Multi noPS",
            "experimental": True,
            "note": "Direct instrument-family transcription; no separated audio stems. Local optional installation; license review needed before redistribution.",
        },
        "ffmpeg": {"ready": bool(binary("ffmpeg") and binary("ffprobe"))},
        "quality": {"ready": (quality_root / ".venv/bin/python").is_file() and (quality_root / "beat-this-final0.ckpt").is_file(), "model": "BeatThis / FCPE / independent pitch verification / piano onset consensus", "note": "Editable proposals, not verified transcription accuracy."},
    }

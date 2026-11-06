from __future__ import annotations

import argparse
import hashlib
import json
import urllib.request
from pathlib import Path

from .config import DEMUCS_FILE, MODELS_DIR

AST_REVISION = "f826b80d28226b62986cc218e5cec390b1096902"


def download(url: str, destination: Path) -> None:
    if destination.is_file():
        print(f"Already installed: {destination.name}")
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".partial")
    print(f"Downloading public model: {destination.name}", flush=True)
    urllib.request.urlretrieve(url, temporary)
    temporary.replace(destination)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        while data := handle.read(1024 * 1024):
            h.update(data)
    return h.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-classifier", action="store_true")
    args = parser.parse_args()
    demucs = MODELS_DIR / "torch" / "checkpoints" / DEMUCS_FILE
    demucs_url = f"https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/{DEMUCS_FILE}"
    download(demucs_url, demucs)
    if not sha256(demucs).startswith("34c22ccb"):
        raise RuntimeError("Demucs checksum mismatch; remove the invalid model and rerun setup.")
    entries = [{"file": str(demucs.relative_to(MODELS_DIR)), "sha256": sha256(demucs), "source": demucs_url, "license": "MIT"}]
    if not args.skip_classifier:
        for name in ("config.json", "preprocessor_config.json", "README.md", "model.safetensors"):
            url = f"https://huggingface.co/MIT/ast-finetuned-audioset-10-10-0.4593/resolve/{AST_REVISION}/{name}"
            destination = MODELS_DIR / "ast" / name
            download(url, destination)
            entries.append({"file": str(destination.relative_to(MODELS_DIR)), "sha256": sha256(destination), "source": url, "license": "BSD-3-Clause (model card)"})
    manifest = MODELS_DIR / "manifest.json"
    manifest.write_text(json.dumps({"models": entries}, indent=2) + "\n", encoding="utf-8")
    print("Model checksums:", manifest)


if __name__ == "__main__":
    main()

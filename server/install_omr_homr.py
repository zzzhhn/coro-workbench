"""Install the pinned homr OMR engine into its own venv under models/omr/homr.

homr is AGPL-3.0 and runs as a separate process, like Audiveris. Weights are
fetched once by homr's own `--init` from its GitHub release and then checked
against pinned SHA256 values; recognition itself needs no network.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from . import config

REPO = "https://github.com/liebharc/homr"
COMMIT = "72fdfa85e59933abb84e5ac2815e5918b28c48d6"
VERSION = "0.7.1.post47+72fdfa8"
# Files written by `homr --init` on Apple Silicon (CoreML segmentation, CPU transformer).
WEIGHTS = {
    "homr/segmentation/segnet_308-3296ccd40960f90ca6ab9c035cca945675d30a0f_fp16.onnx": "60f495496cb41473c0521d0811d8f44b9d5cff892d287974a8aebb3eaee2fa83",
    "homr/transformer/encoder_pytorch_model_566-ccd1cb311c368b5711dd238d2464c615397a3f2b.onnx": "ab4135c1ad65883bf9a63f19cb600911d69f3ef5e8cb9deaccfa562b326db38c",
    "homr/transformer/decoder_pytorch_model_566-ccd1cb311c368b5711dd238d2464c615397a3f2b.onnx": "c6075364b02bd2cc7b47e428d518fa5c5e84412ae62bf38542ea4e567afbed47",
    "homr/staff_relations/staff_pieces_h1-165e413e0edb2d8d2486e2bface8f345e6641ec9.onnx": "24c77f647cb0f8f01480089c2f43648c7aead76e75d0ab26667445f3e2fd3f65",
    "homr/staff_relations/staff_relations_pdmx2-cc40992a36690003f7ed2bebe197016f19242fa6.onnx": "893336b40287303b335b3c9ff9c678316e6f00d95e87973fe12cd0e4d0b2a582",
}


def checksum(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    home = config.MODELS_DIR / "omr" / "homr"
    source = home / "src"
    uv = shutil.which("uv")
    if not uv:
        raise SystemExit("Install uv first: https://docs.astral.sh/uv/")
    print("Optional OMR: homr (AGPL-3.0). Review AGPL and model-data terms (see homr LICENSE_FAQ.md) before hosting or redistribution.")
    if not (source / ".git").is_dir():
        home.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "clone", "--quiet", REPO, str(source)], check=True, timeout=300)
    subprocess.run(["git", "-C", str(source), "checkout", "--quiet", COMMIT], check=True, timeout=60)
    head = subprocess.run(["git", "-C", str(source), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    if head != COMMIT:
        raise SystemExit(f"homr checkout is {head}, expected {COMMIT}.")
    venv = source / ".venv"
    if not (venv / "bin" / "python").is_file():
        subprocess.run([uv, "venv", "--quiet", "-p", "3.12", str(venv)], check=True, timeout=300)
    # uv splits -c/-e values on spaces (Coro's default folder has one), so pass
    # a copied constraints file and install the editable source relative to cwd.
    with tempfile.TemporaryDirectory(prefix="coro-homr-") as temporary:
        pins = Path(temporary) / "constraints.txt"
        shutil.copyfile(config.ROOT / "requirements-omr-homr.txt", pins)
        subprocess.run([uv, "pip", "install", "--quiet", "-p", ".venv/bin/python", "--constraints", str(pins), "-e", ".[cpu]"], check=True, timeout=1200, cwd=source)
    subprocess.run([str(venv / "bin" / "homr"), "--init", "--no-title"], check=True, timeout=1200, cwd=source)
    hashes = {}
    for relative, expected in WEIGHTS.items():
        path = source / relative
        if not path.is_file() or checksum(path) != expected:
            raise SystemExit(f"homr weight {relative} is missing or does not match the pinned SHA256; not marking homr ready.")
        hashes[relative] = expected
    manifest = {"engine": "homr", "version": VERSION, "commit": COMMIT, "license": "AGPL-3.0", "source": f"{REPO}/tree/{COMMIT}", "weights": hashes}
    (home / "verified-install.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Verified homr installed at {home}")


if __name__ == "__main__":
    main()

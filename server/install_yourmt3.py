"""Explicit optional download with pinned revisions and checksums, never called by inference."""
from __future__ import annotations

import concurrent.futures
import hashlib
import json
import urllib.request
from pathlib import Path

from .config import MODELS_DIR, ROOT


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as file:
        while block := file.read(1024 * 1024):
            h.update(block)
    return h.hexdigest()


def fetch(url: str, destination: Path, sha256: str) -> None:
    if destination.is_file() and digest(destination) == sha256:
        return
    if destination.exists():
        raise RuntimeError(f"Existing file differs from pinned checksum: {destination}. It was not overwritten.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".partial")
    with urllib.request.urlopen(url, timeout=60) as response, temporary.open("wb") as output:
        while block := response.read(1024 * 1024):
            output.write(block)
    if digest(temporary) != sha256:
        raise RuntimeError(f"Checksum mismatch: {destination.name}; not installed.")
    temporary.replace(destination)


def main() -> None:
    manifest = json.loads((ROOT / "server" / "yourmt3-manifest.json").read_text())
    destination = MODELS_DIR / "yourmt3"
    destination.mkdir(parents=True, exist_ok=True)
    print("Installing optional YourMT3+ research component into ignored models/yourmt3.")
    print(manifest["licenseNote"])

    def install_source(item):
        path = item["path"]
        url = f"https://huggingface.co/spaces/mimbres/YourMT3/resolve/{manifest['spaceRevision']}/{path}"
        fetch(url, destination / path, item["sha256"])

    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
        list(executor.map(install_source, manifest["sourceFiles"]))
    checkpoint = manifest["checkpoint"]
    path = checkpoint["path"]
    url = f"https://huggingface.co/mimbres/YourMT3/resolve/{manifest['modelRevision']}/{path.removeprefix('amt/')}"
    print("Downloading/verifying 562MB checkpoint...", flush=True)
    fetch(url, destination / path, checkpoint["sha256"])
    (destination / "verified-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print("Verified all optional model/source hashes. No audio has been uploaded.")


if __name__ == "__main__":
    main()

"""Install the pinned optional local OMR runtime without a global app installation."""
from __future__ import annotations

import hashlib
import json
import platform
import shutil
import subprocess
import tempfile
import urllib.request
from pathlib import Path

from . import config

DMG_NAME = "Audiveris-5.11.0-macosx-arm64.dmg"
DMG_URL = f"https://github.com/Audiveris/audiveris/releases/download/5.11.0/{DMG_NAME}"
DMG_SHA256 = "17491af8b6d40153b031dd1f0815e37213f0999ef23f10586af46706e59b2eb6"
OCR_REVISION = "ced78752cc61322fb554c280d13360b35b8684e4"
OCR_URL = f"https://raw.githubusercontent.com/tesseract-ocr/tessdata/{OCR_REVISION}/eng.traineddata"
OCR_SHA256 = "daa0c97d651c19fba3b25e81317cd697e9908c8208090c94c3905381c23fc047"


def checksum(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def download(url: str, destination: Path, expected: str) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_file() and checksum(destination) == expected:
        return
    temporary = destination.with_suffix(destination.suffix + ".download")
    request = urllib.request.Request(url, headers={"User-Agent": "Coro-local-OMR-installer/0.1"})
    with urllib.request.urlopen(request, timeout=90) as source, temporary.open("wb") as target:
        shutil.copyfileobj(source, target)
    if checksum(temporary) != expected:
        raise RuntimeError(f"SHA256 mismatch for {destination.name}; downloaded file was not installed.")
    temporary.replace(destination)


def main() -> None:
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise SystemExit("This pinned installer currently targets Apple Silicon macOS. Do not install the wrong architecture.")
    home = config.MODELS_DIR / "omr"
    dmg = home / "downloads" / DMG_NAME
    print("Optional OMR: Audiveris 5.11.0 (AGPL-3.0) and Tesseract English data (Apache-2.0).")
    print("License obligations must be reviewed before distributing or hosting this component.")
    download(DMG_URL, dmg, DMG_SHA256)
    app = home / "Audiveris.app"
    if not (app / "Contents" / "app" / "audiveris.jar").is_file():
        mount = Path(tempfile.mkdtemp(prefix="coro-audiveris-mount-"))
        mounted = False
        try:
            subprocess.run(["hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", str(mount), str(dmg)], input="Y\n", text=True, stdout=subprocess.DEVNULL, check=True, timeout=90)
            mounted = True
            subprocess.run(["ditto", str(mount / "Audiveris.app"), str(app)], check=True, timeout=120)
        finally:
            if mounted:
                subprocess.run(["hdiutil", "detach", str(mount)], stdout=subprocess.DEVNULL, check=False, timeout=45)
            if mount.exists() and not any(mount.iterdir()):
                mount.rmdir()
    ocr = home / "tessdata" / "eng.traineddata"
    download(OCR_URL, ocr, OCR_SHA256)
    java = app / "Contents" / "runtime" / "Contents" / "Home" / "bin" / "java"
    result = subprocess.run([str(java), "-version"], capture_output=True, text=True, check=True)
    manifest = {
        "engine": "Audiveris", "version": "5.11.0", "license": "AGPL-3.0", "source": "https://github.com/Audiveris/audiveris/tree/5.11.0",
        "releaseUrl": DMG_URL, "releaseSha256": DMG_SHA256,
        "ocrUrl": OCR_URL, "ocrSha256": OCR_SHA256,
        "audiverisJarSha256": checksum(app / "Contents" / "app" / "audiveris.jar"),
        "java": result.stderr.strip(),
    }
    (home / "verified-install.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Verified runtime installed at {home}")


if __name__ == "__main__":
    main()

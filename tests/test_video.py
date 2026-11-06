from __future__ import annotations

import io
import json
import math
import wave
from pathlib import Path
from zipfile import ZipFile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from server.video import create_video_router, encode, validate_package
from server.storage import atomic_json


def video_package(duration=1.0, width=1920, extra=None):
    pcm = io.BytesIO()
    with wave.open(pcm, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(44100)
        import array
        samples = array.array("h", [int(math.sin(2 * math.pi * 440 * i / 44100) * 8000) for i in range(int(duration * 44100))])
        audio.writeframes(samples.tobytes())
    image = io.BytesIO(); Image.new("RGB", (width, 1080), "white").save(image, format="PNG")
    output = io.BytesIO()
    with ZipFile(output, "w") as archive:
        archive.writestr("manifest.json", json.dumps({"frames": [{"file": "frame-0000.png", "duration": duration}]}))
        archive.writestr("frame-0000.png", image.getvalue())
        archive.writestr("audio.wav", pcm.getvalue())
        if extra: archive.writestr(extra, b"not allowed")
    return output.getvalue()


def test_package_paths_dimensions_and_duration(tmp_path):
    (tmp_path / "render.zip").write_bytes(video_package())
    assert validate_package(tmp_path)["duration"] == 1
    (tmp_path / "render.zip").write_bytes(video_package(extra="../escape"))
    with pytest.raises(ValueError, match="未知文件"):
        validate_package(tmp_path)
    assert not (tmp_path.parent / "escape").exists()
    (tmp_path / "render.zip").write_bytes(video_package(width=32))
    with pytest.raises(ValueError, match="1920"):
        validate_package(tmp_path)


def test_rejects_duplicate_zip_names(tmp_path):
    with ZipFile(tmp_path / "render.zip", "w") as archive:
        archive.writestr("manifest.json", "{}")
        with pytest.warns(UserWarning): archive.writestr("manifest.json", "{}")
    with pytest.raises(ValueError, match="限制"):
        validate_package(tmp_path)


def test_actual_h264_aac_encoding(tmp_path):
    from server import config
    if not config.binary("ffmpeg") or not config.binary("ffprobe"):
        pytest.skip("requires actual FFmpeg")
    (tmp_path / "render.zip").write_bytes(video_package())
    atomic_json(tmp_path / "status.json", {"id": tmp_path.name, "status": "queued", "progress": 0})
    encode(tmp_path)
    import subprocess
    result = subprocess.run([config.binary("ffprobe"), "-v", "error", "-show_streams", "-show_format", "-of", "json", str(tmp_path / "score.mp4")], capture_output=True, text=True, check=True)
    data = json.loads(result.stdout)
    assert {s["codec_name"] for s in data["streams"]} == {"h264", "aac"}
    assert abs(float(data["format"]["duration"]) - 1) < 0.1
    video = next(s for s in data["streams"] if s["codec_type"] == "video")
    audio = next(s for s in data["streams"] if s["codec_type"] == "audio")
    assert abs(float(video["duration"]) - float(audio["duration"])) < 1 / 24 + 0.01
    assert json.loads((tmp_path / "status.json").read_text())["status"] == "complete"


def test_video_router_cancel_and_files(tmp_path, monkeypatch):
    app = FastAPI(); router = create_video_router(tmp_path); app.include_router(router)
    monkeypatch.setattr(router.video_manager, "submit", lambda _: None)
    with TestClient(app) as client:
        created = client.post("/api/video", files={"file": ("x.zip", video_package(), "application/zip")})
        assert created.status_code == 202
        id = created.json()["id"]
        assert client.get(f"/api/video/jobs/{id}").json()["status"] == "queued"
        assert client.get(f"/api/video/jobs/{id}/download").status_code == 404
        assert client.delete(f"/api/video/jobs/{id}").json()["status"] == "cancelled"
        assert client.get("/api/video/jobs/not-an-id").status_code == 404

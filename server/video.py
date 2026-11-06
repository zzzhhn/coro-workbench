from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import json
import math
import os
import signal
import subprocess
import sys
import threading
import time
import uuid
import wave
from contextlib import asynccontextmanager
from pathlib import Path
from zipfile import BadZipFile, ZipFile

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from . import config
from .storage import JOB_ID, JobStatus, atomic_json, read_json, utc_now

MAX_UPLOAD = 300 * 1024 * 1024
MAX_EXPANDED = 500 * 1024 * 1024
MAX_DURATION = 1200


def validate_package(directory: Path) -> dict:
    from PIL import Image

    try:
        archive = ZipFile(directory / "render.zip")
    except BadZipFile as error:
        raise ValueError("视频渲染包损坏。") from error
    with archive:
        entries = archive.infolist()
        names = [item.filename for item in entries]
        if len(names) != len(set(names)) or len(entries) > 514 or sum(item.file_size for item in entries) > MAX_EXPANDED:
            raise ValueError("视频渲染包超出大小或条目限制。")
        if "manifest.json" not in names or "audio.wav" not in names:
            raise ValueError("视频渲染包缺少乐谱时序或音频。")
        if archive.getinfo("manifest.json").file_size > 1_000_000:
            raise ValueError("视频时序清单过大。")
        manifest = json.loads(archive.read("manifest.json"))
        frames = manifest.get("frames")
        if not isinstance(frames, list) or not 1 <= len(frames) <= 512:
            raise ValueError("视频需要 1–512 张谱面。")
        duration = 0.0
        expected = {"manifest.json", "audio.wav"}
        for index, frame in enumerate(frames):
            if not isinstance(frame, dict) or frame.get("file") != f"frame-{index:04d}.png":
                raise ValueError("谱面帧编号或路径不安全。")
            length = frame.get("duration")
            if isinstance(length, bool) or not isinstance(length, (int, float)) or not math.isfinite(length) or length <= 0 or length > MAX_DURATION:
                raise ValueError("谱面帧时长无效。")
            duration += length
            expected.add(frame["file"])
        if duration > MAX_DURATION or set(names) != expected:
            raise ValueError("视频过长或渲染包含未知文件。")
        for item in entries:
            if item.filename not in expected or item.file_size > MAX_UPLOAD:
                raise ValueError("渲染包包含不安全文件。")
            with archive.open(item) as source, (directory / item.filename).open("wb") as target:
                while block := source.read(1024 * 1024):
                    target.write(block)
    try:
        with wave.open(str(directory / "audio.wav")) as audio:
            audio_seconds = audio.getnframes() / audio.getframerate()
            if audio.getnchannels() not in (1, 2) or audio.getsampwidth() != 2 or audio.getframerate() not in (22050, 44100, 48000):
                raise ValueError("视频音轨需为标准 PCM WAV。")
            if audio_seconds > MAX_DURATION + 1 or abs(audio_seconds - duration) > 1:
                raise ValueError("谱面与音频时长不一致。")
    except (wave.Error, ZeroDivisionError) as error:
        raise ValueError("视频音轨不可读取。") from error
    for frame in frames:
        path = directory / frame["file"]
        with Image.open(path) as image:
            if image.format != "PNG" or image.size != (1920, 1080):
                raise ValueError("谱面帧必须是 1920 × 1080 PNG。")
            image.verify()
    manifest["duration"] = audio_seconds
    return manifest


def encode(directory: Path) -> None:
    status = JobStatus(directory)
    status.update(3, "validating", "检查谱面帧、音乐时序与音轨。")
    manifest = validate_package(directory)
    status.check_cancelled()
    frames = manifest["frames"]
    lines = ["ffconcat version 1.0"]
    for frame in frames:
        lines += [f"file '{frame['file']}'", f"duration {frame['duration']:.9f}"]
    lines.append(f"file '{frames[-1]['file']}'")
    (directory / "frames.ffconcat").write_text("\n".join(lines) + "\n")
    ffmpeg = config.binary("ffmpeg")
    if not ffmpeg:
        raise ValueError("本机未安装 FFmpeg，不能生成 MP4。")
    command = [ffmpeg, "-hide_banner", "-nostdin", "-y", "-protocol_whitelist", "file,pipe", "-safe", "1", "-f", "concat", "-i", "frames.ffconcat", "-i", "audio.wav", "-map", "0:v:0", "-map", "1:a:0", "-vf", "tpad=stop_mode=clone:stop_duration=2,fps=24", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-t", f"{manifest['duration']:.9f}", "-movflags", "+faststart", "-threads", "4", "-progress", "progress.txt", "score.mp4"]
    status.update(8, "encoding", "正在本机编码 H.264 视频与 AAC 排练音轨。")
    with (directory / "ffmpeg.log").open("wb") as log:
        process = subprocess.Popen(command, cwd=directory, stdout=log, stderr=log)
        deadline = time.monotonic() + 120 + manifest["duration"] * 3
        last = -1
        try:
            while process.poll() is None:
                status.check_cancelled()
                if time.monotonic() > deadline:
                    raise ValueError("MP4 编码超时，请导出较少声部或较短乐谱。")
                progress = directory / "progress.txt"
                if progress.exists():
                    text = progress.read_text(errors="replace")
                    values = [line.split("=", 1)[1] for line in text.splitlines() if line.startswith("out_time_us=")]
                    if values and values[-1].isdigit():
                        percent = min(97, 8 + round(int(values[-1]) / 1_000_000 / manifest["duration"] * 89))
                        if percent != last:
                            status.update(percent, "encoding", "正在本机编码视频，原曲与乐谱不会被修改。")
                            last = percent
                time.sleep(0.25)
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
        if process.returncode:
            raise ValueError("MP4 编码失败，请检查本机 FFmpeg 日志。")
    target = directory / "score.mp4"
    if not target.is_file() or target.stat().st_size < 1000:
        raise ValueError("未生成有效 MP4。")
    status.check_cancelled()
    result = status.read()
    result.update(status="complete", progress=100, stage="complete", message="MP4 已生成。", downloadUrl=f"/api/video/jobs/{directory.name}/download", duration=manifest["duration"], frames=len(frames), updatedAt=utc_now())
    atomic_json(directory / "status.json", result)


class VideoManager:
    def __init__(self, root: Path):
        self.directory = root / "video"
        self.lock = threading.Lock()
        self.executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        self.processes: dict[str, subprocess.Popen] = {}
        self.futures = {}
        self.uploads = 0

    def recover(self):
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        for path in self.directory.glob("*/status.json"):
            try:
                if read_json(path)["status"] in {"queued", "running"}:
                    JobStatus(path.parent).fail("服务重启中断了视频编码，请重新导出。")
            except (OSError, ValueError, KeyError):
                continue

    def reserve(self):
        with self.lock:
            if self.uploads + sum(not future.done() for future in self.futures.values()) >= 3:
                return False
            self.uploads += 1
            return True

    def release(self):
        with self.lock:
            self.uploads = max(0, self.uploads - 1)

    def run(self, job_id):
        folder = self.directory / job_id
        if (folder / "cancelled").exists():
            return
        try:
            with (folder / "worker.log").open("wb") as log:
                process = subprocess.Popen([sys.executable, "-m", "server.video_worker", str(folder)], cwd=config.ROOT, stdout=log, stderr=log, start_new_session=True)
                with self.lock:
                    self.processes[job_id] = process
                if (folder / "cancelled").exists():
                    self.terminate(process)
                process.wait()
            if JobStatus(folder).read()["status"] not in {"complete", "error", "cancelled"}:
                JobStatus(folder).fail("视频编码进程异常退出。")
        finally:
            with self.lock:
                self.processes.pop(job_id, None)

    def submit(self, job_id):
        with self.lock:
            self.futures = {key: future for key, future in self.futures.items() if not future.done()}
            self.futures[job_id] = self.executor.submit(self.run, job_id)

    @staticmethod
    def terminate(process):
        if process.poll() is not None:
            return
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)

    def cancel(self, job_id):
        (self.directory / job_id / "cancelled").touch()
        with self.lock:
            process = self.processes.get(job_id)
            future = self.futures.get(job_id)
        if future:
            future.cancel()
        if process:
            self.terminate(process)

    def close(self):
        with self.lock:
            processes = list(self.processes.values())
        for process in processes:
            self.terminate(process)
        self.executor.shutdown(wait=False, cancel_futures=True)


def create_video_router(root: Path) -> APIRouter:
    manager = VideoManager(root)

    @asynccontextmanager
    async def lifespan(_):
        manager.recover()
        yield
        manager.close()

    router = APIRouter(prefix="/api/video", tags=["local-video"], lifespan=lifespan)
    router.video_manager = manager

    def folder(job_id):
        if not JOB_ID.fullmatch(job_id):
            raise HTTPException(404, "找不到视频任务。")
        path = manager.directory / job_id
        if path.is_symlink() or not (path / "status.json").is_file():
            raise HTTPException(404, "找不到视频任务。")
        return path

    @router.post("", status_code=202)
    async def upload(file: UploadFile = File(...)):
        if not config.binary("ffmpeg"):
            raise HTTPException(503, "本机 FFmpeg 未安装。")
        if not manager.reserve():
            raise HTTPException(429, "视频导出队列已满，请稍后重试。")
        job_id = uuid.uuid4().hex
        path = manager.directory / job_id
        try:
            path.mkdir(parents=True, mode=0o700)
            size = 0
            with (path / "render.zip").open("wb") as target:
                while chunk := await file.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_UPLOAD:
                        raise HTTPException(413, "视频渲染包不能超过 300 MB。")
                    target.write(chunk)
            state = {"id": job_id, "status": "queued", "progress": 0, "stage": "queued", "message": "等待本地视频编码。", "createdAt": utc_now(), "updatedAt": utc_now()}
            atomic_json(path / "status.json", state)
            manager.submit(job_id)
            return state
        except OSError as error:
            raise HTTPException(507, "本机无法保存视频文件，请检查磁盘空间。") from error
        finally:
            manager.release()
            await file.close()

    @router.get("/jobs/{job_id}")
    def job(job_id: str):
        return JobStatus(folder(job_id)).read()

    @router.delete("/jobs/{job_id}")
    async def cancel(job_id: str):
        path = folder(job_id)
        if JobStatus(path).read()["status"] in {"queued", "running"}:
            await asyncio.to_thread(manager.cancel, job_id)
        state = JobStatus(path).read()
        if state["status"] == "cancelled":
            state["message"] = "视频导出已取消。"
        return state

    @router.get("/jobs/{job_id}/download")
    def download(job_id: str):
        path = folder(job_id)
        target = path / "score.mp4"
        if JobStatus(path).read()["status"] != "complete" or not target.is_file() or target.is_symlink():
            raise HTTPException(404, "视频尚未生成。")
        return FileResponse(target, media_type="video/mp4", filename="coro-rehearsal.mp4")

    return router

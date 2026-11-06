from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import os
import signal
import subprocess
import sys
import threading
import uuid
import wave
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, JSONResponse

from . import config
from .storage import JOB_ID, JobStatus, atomic_json, read_json, utc_now
from .omr import create_omr_router, omr_health
from .video import create_video_router


class JobManager:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.executor = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="coro-analysis")
        self.lock = threading.Lock()
        self.processes: dict[str, subprocess.Popen] = {}
        self.futures: dict[str, concurrent.futures.Future] = {}
        self.pending_uploads = 0

    def recover(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.data_dir.chmod(0o700)
        for path in self.data_dir.glob("*/status.json"):
            try:
                status = read_json(path)
                if status.get("status") in {"queued", "running"} and not (path.parent / "cancelled").exists():
                    JobStatus(path.parent).fail("服务重启中断了分析，请重新上传。原始音频仍保留在本机。")
            except (OSError, ValueError):
                continue

    def active_count(self) -> int:
        with self.lock:
            return self.pending_uploads + sum(not f.done() for f in self.futures.values())

    def reserve_upload(self) -> bool:
        with self.lock:
            count = self.pending_uploads + sum(not f.done() for f in self.futures.values())
            if count >= config.MAX_PENDING_JOBS:
                return False
            self.pending_uploads += 1
            return True

    def release_upload(self) -> None:
        with self.lock:
            self.pending_uploads -= 1

    def submit(self, job_id: str) -> None:
        with self.lock:
            self.futures = {key: value for key, value in self.futures.items() if not value.done()}
            self.futures[job_id] = self.executor.submit(self._run, job_id)

    def _run(self, job_id: str) -> None:
        directory = self.data_dir / job_id
        status = JobStatus(directory)
        if status.cancel_path.exists():
            return
        env = dict(os.environ, CORO_DATA_DIR=str(self.data_dir), CORO_MODELS_DIR=str(config.MODELS_DIR), OMP_NUM_THREADS="4", OPENBLAS_NUM_THREADS="4", HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", TOKENIZERS_PARALLELISM="false")
        try:
            with (directory / "worker.log").open("a", encoding="utf-8") as log:
                process = subprocess.Popen([sys.executable, "-m", "server.worker", job_id], cwd=config.ROOT, env=env, stdout=log, stderr=log, start_new_session=True)
                with self.lock:
                    self.processes[job_id] = process
                if status.cancel_path.exists():
                    self._terminate(process)
                return_code = process.wait()
            if not status.cancel_path.exists() and status.read()["status"] not in {"complete", "error"}:
                status.fail(f"分析进程意外退出（代码 {return_code}）。请缩短音频后重试；详情保存在本机日志。")
        except Exception:
            status.fail("无法启动本地分析进程。请检查 Python 环境与本机日志。")
        finally:
            with self.lock:
                self.processes.pop(job_id, None)

    @staticmethod
    def _terminate(process: subprocess.Popen) -> None:
        if process.poll() is not None:
            return
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)

    def cancel(self, job_id: str) -> None:
        (self.data_dir / job_id / "cancelled").touch()
        with self.lock:
            future = self.futures.get(job_id)
            process = self.processes.get(job_id)
        if future:
            future.cancel()
        if process:
            self._terminate(process)

    def close(self) -> None:
        with self.lock:
            processes = list(self.processes.values())
        for process in processes:
            self._terminate(process)
        self.executor.shutdown(wait=False, cancel_futures=True)


class UploadLimitMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method") != "POST":
            await self.app(scope, receive, send)
            return
        headers = dict(scope.get("headers", []))
        limit = (300 * 1024 * 1024 if scope.get("path") == "/api/video" else config.MAX_UPLOAD_BYTES) + 1024 * 1024
        content_length = headers.get(b"content-length")
        if content_length:
            try:
                if int(content_length) > limit:
                    await JSONResponse({"detail": "上传文件超过当前接口的大小限制。"}, status_code=413)(scope, receive, send)
                    return
            except ValueError:
                await JSONResponse({"detail": "无效的请求大小。"}, status_code=400)(scope, receive, send)
                return
        received = 0

        async def bounded_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise HTTPException(413, "音频文件不能超过 100 MB。")
            return message

        await self.app(scope, bounded_receive, send)


def create_app(data_dir: Path | None = None) -> FastAPI:
    directory = data_dir or config.DATA_DIR
    manager = JobManager(directory)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        manager.recover()
        yield
        manager.close()

    app = FastAPI(title="Coro Local Audio", version="0.1.0", lifespan=lifespan)
    app.state.manager = manager
    app.include_router(create_omr_router(directory))
    app.include_router(create_video_router(directory))
    app.add_middleware(UploadLimitMiddleware)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1", "[::1]", "testserver"])
    allowed = [f"http://{host}:{port}" for host in ("localhost", "127.0.0.1") for port in (5173, 4173, 3000, 8765)]
    allowed += [origin.strip() for origin in os.environ.get("CORO_ALLOWED_ORIGINS", "").split(",") if origin.strip()]
    app.add_middleware(CORSMiddleware, allow_origins=allowed, allow_credentials=False, allow_methods=["GET", "POST", "DELETE"], allow_headers=["Content-Type", "Range"], expose_headers=["Content-Range", "Accept-Ranges"])

    @app.middleware("http")
    async def guard_local_writes(request: Request, call_next):
        origin = request.headers.get("origin")
        if request.method not in {"GET", "HEAD", "OPTIONS"} and origin and origin not in allowed:
            return JSONResponse({"detail": "只允许本机 Coro 页面提交分析。"}, status_code=403)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Cache-Control"] = "no-store"
        return response

    def get_directory(job_id: str) -> Path:
        if not JOB_ID.fullmatch(job_id):
            raise HTTPException(404, "找不到分析任务。")
        target = directory / job_id
        if not target.is_dir() or not (target / "status.json").is_file():
            raise HTTPException(404, "找不到分析任务。")
        return target

    @app.get("/api/health")
    def health():
        engines = config.engine_health()
        engines["omr"] = omr_health()
        engines["video"] = {"ready": bool(config.binary("ffmpeg")), "format": "H.264/AAC MP4", "localOnly": True}
        try:
            from .chordino import runtime_health
            engines["harmony"] = runtime_health()
        except (ImportError, OSError, ValueError):
            engines["harmony"] = {"ready": False, "backend": "Chordino", "note": "Optional local audio harmony runtime unavailable; symbolic fallback retained"}
        try:
            from .rosvot import runtime_health as vocal_note_health
            engines["vocalNotes"] = vocal_note_health()
        except (ImportError, OSError, ValueError):
            engines["vocalNotes"] = {"ready": False, "backend": "ROSVOT", "note": "Learned vocal note runtime unavailable; acoustic decoder retained"}
        ready = engines["basicPitch"]["ready"] and engines["ffmpeg"]["ready"]
        return {"status": "ok" if ready else "setup_required", "engines": engines, "localOnly": True, "activeJobs": manager.active_count(), "limits": {"maxUploadMB": 100, "maxDurationSeconds": config.MAX_DURATION_SECONDS, "maxAnalysisSeconds": config.MAX_ANALYSIS_SECONDS, "maxPendingJobs": config.MAX_PENDING_JOBS}, "privacy": "文件只保存在本机，分析不调用云端 API。"}

    @app.post("/api/analyze", status_code=202)
    async def analyze(file: UploadFile = File(...), mode: str = Form("quick"), tempo: float | None = Form(None), max_seconds: float = Form(90), quality: str = Form("auto"), decoder: str = Form("rosvot"), verification: str = Form("full")):
        if mode not in {"quick", "separate", "multi"}:
            raise HTTPException(422, "mode 必须是 quick、separate 或 multi。")
        if quality not in {"auto", "raw"}:
            raise HTTPException(422, "quality 必须是 auto 或 raw。")
        if decoder not in {"standard", "legato", "acoustic", "rosvot"}:
            raise HTTPException(422, "decoder 必须是 standard、legato、acoustic 或 rosvot。")
        if verification not in {"full", "sampled"}:
            raise HTTPException(422, "verification 必须是 full 或 sampled。")
        if tempo is not None and not (30 <= tempo <= 240):
            raise HTTPException(422, "速度必须在 30–240 BPM 之间。")
        if not (1 <= max_seconds <= config.MAX_ANALYSIS_SECONDS):
            raise HTTPException(422, "分析时长必须在 1–300 秒之间。")
        filename = Path((file.filename or "audio").replace("\\", "/")).name[:240]
        suffix = Path(filename).suffix.lower()
        if suffix not in config.ALLOWED_EXTENSIONS:
            raise HTTPException(415, "请选择 WAV、MP3、FLAC、OGG、M4A、AAC、OPUS 或 AIFF 音频。MIDI / MusicXML 请从乐谱导入。")
        engines = config.engine_health()
        if (mode != "multi" and not engines["basicPitch"]["ready"]) or not engines["ffmpeg"]["ready"]:
            raise HTTPException(503, "本地转写引擎未就绪，请运行 scripts/setup-audio.sh。")
        if mode == "separate" and not engines["demucs"]["ready"]:
            raise HTTPException(503, "分轨模型未就绪，请运行 scripts/setup-audio.sh --models。")
        if mode == "multi" and not engines.get("yourMT3", {}).get("ready"):
            raise HTTPException(503, "多乐器族群实验引擎未安装，请运行 scripts/setup-yourmt3.sh。")
        if not manager.reserve_upload():
            raise HTTPException(429, "本机分析队列已满（最多 4 个），请等待或取消已有任务。")
        job_id = uuid.uuid4().hex
        target = directory / job_id
        try:
            target.mkdir(parents=True, mode=0o700)
        except OSError as error:
            manager.release_upload()
            raise HTTPException(507, "本机磁盘无法保存音频，请检查空间与目录权限。") from error
        upload_path = target / f"source{suffix}"
        size = 0
        try:
            with upload_path.open("wb") as output:
                while chunk := await file.read(1024 * 1024):
                    size += len(chunk)
                    if size > config.MAX_UPLOAD_BYTES:
                        raise HTTPException(413, "音频文件不能超过 100 MB。")
                    output.write(chunk)
            if size < 44:
                raise HTTPException(422, "音频为空或过短。")
        except BaseException:
            upload_path.unlink(missing_ok=True)
            target.rmdir()
            manager.release_upload()
            raise
        finally:
            await file.close()
        result = {"id": job_id, "status": "queued", "progress": 0, "stage": "queued", "message": "等待本地分析。首次运行需要加载模型。", "createdAt": utc_now(), "updatedAt": utc_now()}
        try:
            atomic_json(target / "request.json", {"id": job_id, "filename": filename, "input": upload_path.name, "mode": mode, "tempo": tempo, "max_seconds": max_seconds, "quality": quality, "decoder": decoder, "verification": verification})
            atomic_json(target / "status.json", result)
            manager.submit(job_id)
        finally:
            manager.release_upload()
        return result

    @app.get("/api/jobs/{job_id}")
    def job(job_id: str):
        return JobStatus(get_directory(job_id)).read()

    @app.get("/api/projects/{job_id}/raw")
    def raw_project(job_id: str):
        path = get_directory(job_id) / "raw-project.json"
        if not path.is_file() or path.is_symlink():
            raise HTTPException(404, "该任务没有保留原始模型乐谱。")
        return FileResponse(path, media_type="application/json", filename="raw-transcription.coro.json")

    @app.get("/api/projects")
    def completed_projects(limit: int = 30):
        if not 1 <= limit <= 100:
            raise HTTPException(422, "limit 必须在 1–100 之间。")
        results = []
        paths = sorted(directory.glob("*/status.json"), key=lambda path: path.stat().st_mtime, reverse=True)
        for path in paths:
            if not JOB_ID.fullmatch(path.parent.name) or path.parent.is_symlink():
                continue
            try:
                state = JobStatus(path.parent).read()
                project = state.get("project")
                if state.get("status") != "complete" or not isinstance(project, dict):
                    continue
                request = read_json(path.parent / "request.json")
                audio = project.get("originalAudio") or {}
                analysis = project.get("source", {}).get("analysis") or {}
                quality = analysis.get("quality") or {}
                full = float(audio.get("duration", 0))
                requested = float(request.get("max_seconds", 0))
                analyzed = min(full, requested)
                analyzed_audio = path.parent / "analysis.wav"
                if analyzed_audio.is_file() and not analyzed_audio.is_symlink():
                    with wave.open(str(analyzed_audio), "rb") as audio_file:
                        analyzed = audio_file.getnframes() / audio_file.getframerate()
                results.append({"id": path.parent.name, "title": project.get("title", "未命名转写"), "filename": project.get("source", {}).get("filename", ""), "createdAt": state.get("createdAt", ""), "updatedAt": state.get("updatedAt", ""), "tempo": project.get("tempo"), "measures": project.get("measures"), "parts": len(project.get("parts", [])), "duration": full, "analyzedSeconds": analyzed, "mode": request.get("mode", "unknown"), "decoder": quality.get("decoderProfile", request.get("decoder", "standard")), "hasRaw": (path.parent / "raw-project.json").is_file(), "uncertainRegions": len(analysis.get("uncertaintyIntervals") or []), "proposal": bool(analysis.get("transforms"))})
                if len(results) >= limit:
                    break
            except (OSError, ValueError, KeyError, TypeError, wave.Error, EOFError):
                continue
        return {"projects": results, "localOnly": True}

    @app.get("/api/projects/{job_id}/evidence")
    def quality_evidence(job_id: str):
        path = get_directory(job_id) / "quality-evidence.json"
        if not path.is_file() or path.is_symlink():
            raise HTTPException(404, "该任务没有模型分歧证据。")
        return FileResponse(path, media_type="application/json", filename="model-disagreement-evidence.json")

    @app.get("/api/projects/{job_id}/pitch")
    def pitch_evidence(job_id: str, start: float = 0, end: float = 8):
        from .pitch_evidence import read_pitch_window
        try:
            return read_pitch_window(get_directory(job_id), start, end)
        except FileNotFoundError as error:
            raise HTTPException(404, str(error)) from error
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise HTTPException(422, str(error) if isinstance(error, ValueError) else "无法安全读取主唱音高证据。") from error

    @app.get("/api/projects/{job_id}/pitch/coverage")
    def pitch_coverage(job_id: str):
        from .pitch_evidence import read_pitch_coverage
        try:
            return read_pitch_coverage(get_directory(job_id))
        except FileNotFoundError as error:
            raise HTTPException(404, str(error)) from error
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise HTTPException(422, str(error) if isinstance(error, ValueError) else "无法安全读取主唱覆盖证据。") from error

    @app.delete("/api/jobs/{job_id}")
    async def cancel(job_id: str):
        target = get_directory(job_id)
        status = JobStatus(target)
        if status.read()["status"] in {"queued", "running"}:
            await asyncio.to_thread(manager.cancel, job_id)
        return status.read()

    @app.get("/api/audio/{job_id}/{filename}")
    def audio(job_id: str, filename: str):
        target = get_directory(job_id)
        # No user-controlled filename may expose requests, logs, or arbitrary files.
        allowed_files = {"original.wav", "analysis.wav", *(f"stem-{name}.wav" for name in ("vocals", "bass", "drums", "other", "guitar", "piano", "lead", "backing"))}
        if filename not in allowed_files:
            raise HTTPException(404, "找不到音频。")
        path = target / filename
        if not path.is_file() or path.is_symlink():
            raise HTTPException(404, "音频尚未生成。")
        return FileResponse(path, media_type="audio/wav")

    @app.get("/api/source/{job_id}")
    def original_source(job_id: str):
        target = get_directory(job_id)
        request = read_json(target / "request.json")
        name = request.get("input", "")
        if not isinstance(name, str):
            raise HTTPException(404, "找不到原始文件。")
        path = target / name
        if path.name != name or path.stem != "source" or path.suffix not in config.ALLOWED_EXTENSIONS:
            raise HTTPException(404, "找不到原始文件。")
        if not path.is_file() or path.is_symlink():
            raise HTTPException(404, "找不到原始文件。")
        filename = str(request.get("filename", name)).replace("\\", "/").split("/")[-1]
        return FileResponse(path, media_type="application/octet-stream", filename=filename)

    return app


app = create_app()

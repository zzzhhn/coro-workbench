"""Production orchestration for full-length independent voice verification."""
from __future__ import annotations

import hashlib
import importlib.metadata
import json
import math
import os
import subprocess
import time
from pathlib import Path

import soundfile as sf

from . import config
from .storage import JobStatus, atomic_json, read_json

AUDIT_VERSION = "crepe-full-20ms-1s025step-v1"


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def verification_signature(lead_path: Path, fcpe_path: Path) -> dict:
    runtime = config.MODELS_DIR / "audio-quality/.venv"
    models = sorted(runtime.glob("lib/python*/site-packages/torchcrepe/assets/full.pth"))
    if not models or not (runtime / "bin/python").is_file():
        raise ValueError("完整主唱核对引擎未安装，请运行 scripts/setup-audio-quality.sh。")
    versions = {}
    site_packages = models[0].parents[2]
    for distribution in importlib.metadata.distributions(path=[str(site_packages)]):
        name = (distribution.metadata.get("Name") or "").lower()
        if name in {"torchcrepe", "torch", "torchaudio", "librosa", "numpy"}:
            versions[name] = distribution.version
    return {
        "auditVersion": AUDIT_VERSION,
        "leadSha256": file_sha256(lead_path),
        "fcpeSha256": file_sha256(fcpe_path),
        "verifierCodeSha256": file_sha256(config.ROOT / "server/dense_voice_verify.py"),
        "crepeModelSha256": file_sha256(models[0]),
        "runtimeVersions": versions,
    }


def _read_valid_cache(output: Path, signature: dict, duration: float) -> dict | None:
    report_path, manifest_path, contour_path = output / "report.json", output / "cache.json", output / "contours.npz"
    if not all(path.is_file() for path in (report_path, manifest_path, contour_path)):
        return None
    try:
        manifest = read_json(manifest_path)
        if manifest.get("signature") != signature:
            return None
        if manifest.get("reportSha256") != file_sha256(report_path) or manifest.get("contourSha256") != file_sha256(contour_path):
            return None
        report = read_json(report_path)
        if abs(float(report["durationSeconds"]) - duration) > .1 or float(report["processedSeconds"]) < duration - .1:
            return None
        return {**report, "cacheHit": True, "cacheSignature": signature, "contourFile": str(contour_path.resolve())}
    except (OSError, ValueError, KeyError, TypeError):
        return None


def run_dense_voice_verification(directory: Path, lead_path: Path, fcpe_path: Path, status: JobStatus | None = None, timeout_seconds: float | None = None) -> dict:
    """Run in the worker's process group, with content-addressed local cache and real progress."""
    if status:
        status.check_cancelled()
    if not lead_path.is_file() or not fcpe_path.is_file():
        raise ValueError("没有完整主唱音频或连续音高，不能声称完成全段核对。")
    duration = sf.info(lead_path).duration
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("主唱音频时长无效。")
    signature = verification_signature(lead_path, fcpe_path)
    key = hashlib.sha256(json.dumps(signature, sort_keys=True).encode("ascii")).hexdigest()
    output = directory / "dense-voice-audit" / key[:24]
    cached = _read_valid_cache(output, signature, duration)
    if cached:
        if status:
            status.update(99, "voice-verification", "已复用同一主唱音频与音高的完整核对结果（SHA256校验通过）。")
        return cached
    output.mkdir(parents=True, exist_ok=True)
    if status:
        status.update(97, "voice-verification", f"正在完整核对主唱（0 / {duration:.1f} 秒），尚未完成分析。")
    command = [str(config.MODELS_DIR / "audio-quality/.venv/bin/python"), str(config.ROOT / "server/dense_voice_verify.py"), "--audio", str(lead_path.resolve()), "--fcpe", str(fcpe_path.resolve()), "--output", str(output.resolve())]
    environment = dict(os.environ, OMP_NUM_THREADS="4", OPENBLAS_NUM_THREADS="4", HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", WANDB_MODE="disabled")
    timeout = timeout_seconds if timeout_seconds is not None else max(180., duration * 6 + 60)
    # Do not detach: JobManager.cancel terminates this child with the enclosing worker group.
    with (output / "run.log").open("w", encoding="utf-8") as log:
        process = subprocess.Popen(command, cwd=config.ROOT, env=environment, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + timeout
            last_done = -1.
            while process.poll() is None:
                if status:
                    status.check_cancelled()
                if time.monotonic() > deadline:
                    raise ValueError("完整主唱核对超时；当前谱面保留，但不能视为已完整核对。")
                progress_path = output / "progress.json"
                if progress_path.is_file():
                    try:
                        progress = read_json(progress_path)
                        done = min(duration, max(0., float(progress.get("doneSeconds", 0))))
                        if done > last_done + .1:
                            if status:
                                status.update(min(99, 97 + int(2 * done / duration)), "voice-verification", f"正在完整核对主唱（{done:.1f} / {duration:.1f} 秒），谱面仍待最终保存。")
                            last_done = done
                    except (OSError, ValueError, TypeError):
                        pass
                time.sleep(.2)
            if process.returncode != 0 or not (output / "report.json").is_file() or not (output / "contours.npz").is_file():
                raise ValueError("完整主唱核对未完成。谱面提案已保留，请查看本机核对日志。")
            if status:
                status.check_cancelled()
            report = read_json(output / "report.json")
            if abs(float(report.get("durationSeconds", -1)) - duration) > .1 or float(report.get("processedSeconds", -1)) < duration - .1:
                raise ValueError("主唱核对覆盖时长不足，不能标记为完整核对。")
            atomic_json(output / "cache.json", {"signature": signature, "reportSha256": file_sha256(output / "report.json"), "contourSha256": file_sha256(output / "contours.npz")})
            if status:
                status.update(99, "voice-verification", f"主唱 {duration:.1f} 秒已逐帧核对，正在保存分歧区间；不是人工准确率。")
            return {**report, "cacheHit": False, "cacheSignature": signature, "contourFile": str((output / "contours.npz").resolve())}
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


def apply_dense_voice_evidence(project: dict, detailed: dict, audit: dict) -> None:
    """Annotate a project without changing any note, pitch, duration, or source mapping."""
    analysis = project["source"]["analysis"]
    quality = analysis["quality"]
    input_source = audit.get("inputSource", "separated_lead")
    selected_lead = input_source == "separated_lead"
    intervals = audit.get("uncertaintyIntervals", [])
    combined = []
    for interval in sorted([*analysis.get("uncertaintyIntervals", []), *intervals], key=lambda item: (item.get("partId", "vocals"), item["startSeconds"])):
        if combined and combined[-1].get("partId") == interval.get("partId") and interval["startSeconds"] <= combined[-1]["endSeconds"]:
            previous = combined[-1]
            previous["endSeconds"] = max(previous["endSeconds"], interval["endSeconds"])
            if previous["reason"] != interval["reason"]:
                previous["reason"] = "Sampled/full independent pitch checks report disagreement; see model evidence for both findings"
            previous["alternatives"] = list(dict.fromkeys([*previous.get("alternatives", []), *interval.get("alternatives", [])]))
        else:
            combined.append(dict(interval))
    analysis["uncertaintyIntervals"] = combined
    quality.update({
        "verificationMode": "full",
        "verificationStatus": "complete",
        "verificationVersion": AUDIT_VERSION,
        "vocals.pitchEvidenceSource": input_source,
        "vocals.denseVerifiedSeconds": audit["processedSeconds"],
        "vocals.denseJointVoicedSeconds": audit["jointVoicedSeconds"],
        "vocals.denseWithin50Cents": audit["within50CentsOnJointVoiced"],
        "vocals.denseOctaveDisagreement": audit["over6SemitonesOnJointVoiced"],
        "vocals.denseUncertaintyIntervals": len(intervals),
        "vocals.denseLowEvidenceSeconds": audit["unvoicedOrLowEvidenceSeconds"],
        "vocals.independentCheckSeconds": audit["durationSeconds"],
        "vocals.independentCoverageFraction": 1.,
        "vocals.leadIdentityPartial": selected_lead and bool(combined),
        "vocals.leadIdentityAccepted": selected_lead and not combined and not quality.get("vocals.abstained") and float(audit["jointVoicedSeconds"]) >= .8,
        "vocals.denseCacheHit": bool(audit.get("cacheHit")),
    })
    project["source"]["warnings"] = [message for message in project["source"]["warnings"] if not message.startswith("独立音高检查仅抽样")]
    project["source"]["warnings"].append(f"已对当前选定人声{audit['durationSeconds']:g}秒逐帧核对；仅{audit['jointVoicedSeconds']:g}秒有共同发声证据，其余低周期性/非发声不计为正确。模型一致仍不是人工真值或歌手身份确认，音符未自动更改。")
    if combined:
        for part in project["parts"]:
            if part["id"] == "vocals" and not quality.get("vocals.abstained"):
                part["name"] = "主唱提案 · 局部待定"
    analysis["transforms"].append("按完整核对选项，对本次选定的人声音频运行独立CREPE并标记分歧/低证据区间；不改音符、不用九秒抽样代替全段检查，不把普通人声轨标成已确认主唱。")
    detailed["denseVoiceAudit"] = audit

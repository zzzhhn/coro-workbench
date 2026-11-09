"""Bounded, read-only access to stored lead pitch evidence; never runs a model."""
from __future__ import annotations

import hashlib
import math
from pathlib import Path
from zipfile import BadZipFile, ZipFile

import numpy as np

from .storage import read_json

MAX_WINDOW_SECONDS = 24
MAX_CONTOUR_BYTES = 32 * 1024 * 1024
FIELDS = ("time", "fcpeF0", "crepeF0", "periodicity", "activation", "audible", "jointVoiced")


def _read_contours(directory: Path) -> tuple[dict, dict, float, str, float, float]:
    if directory.is_symlink():
        raise ValueError("音高工程路径不能是符号链接。")
    evidence_path = directory / "quality-evidence.json"
    if not evidence_path.is_file() or evidence_path.is_symlink():
        raise FileNotFoundError("这项转写没有保存连续音高校验证据。")
    if evidence_path.stat().st_size > MAX_CONTOUR_BYTES:
        raise ValueError("模型证据超出安全读取上限。")
    audit = read_json(evidence_path).get("denseVoiceAudit")
    if not isinstance(audit, dict) or not isinstance(audit.get("contourFile"), str):
        raise FileNotFoundError("没有完整主唱连续音高；仅抽样或旧版转写需重新完整核对。")
    path = Path(audit["contourFile"])
    if not path.is_absolute():
        path = directory / path
    root = directory.resolve()
    try:
        relative = path.resolve().relative_to(root)
        original_relative = path.absolute().relative_to(directory.absolute())
    except ValueError as error:
        raise ValueError("音高证据路径不属于当前工程。") from error
    if (
        not relative.parts or relative.parts[0] != "dense-voice-audit"
        or relative.name != "contours.npz"
        or path.is_symlink()
        or any((directory / Path(*original_relative.parts[:i])).is_symlink() for i in range(1, len(original_relative.parts)))
    ):
        raise ValueError("音高证据路径无效。")
    if not path.is_file():
        raise FileNotFoundError("连续音高文件已不在本机；原乐谱仍可使用。")
    if path.stat().st_size > MAX_CONTOUR_BYTES:
        raise ValueError("连续音高文件超出安全读取上限。")
    integrity = "stored_file"
    cache_path = path.parent / "cache.json"
    if cache_path.is_file() and not cache_path.is_symlink():
        if cache_path.stat().st_size > MAX_CONTOUR_BYTES:
            raise ValueError("连续音高缓存记录超过安全上限。")
        cached_hash = read_json(cache_path).get("contourSha256")
        if cached_hash != hashlib.sha256(path.read_bytes()).hexdigest():
            raise ValueError("连续音高文件哈希不匹配，未用于校对。")
        integrity = "sha256_checked"
    try:
        with ZipFile(path) as archive:
            if len(archive.infolist()) > 16 or sum(info.file_size for info in archive.infolist()) > MAX_CONTOUR_BYTES:
                raise ValueError("解压音高证据超过安全上限。")
    except BadZipFile as error:
        raise ValueError("连续音高文件已损坏，未用于校对。") from error
    with np.load(path, allow_pickle=False) as stored:
        if not all(field in stored.files for field in FIELDS):
            raise ValueError("连续音高字段不完整。")
        arrays = {field: stored[field] for field in FIELDS}
    times = arrays["time"]
    if times.ndim != 1 or not 1 < len(times) <= 200000 or not np.isfinite(times).all() or not (np.diff(times) > 0).all():
        raise ValueError("连续音高时间轴无效。")
    if any(values.shape != times.shape for values in arrays.values()):
        raise ValueError("连续音高数组长度不一致。")
    if any(not np.issubdtype(values.dtype, np.number) and values.dtype != np.bool_ for values in arrays.values()):
        raise ValueError("连续音高字段必须是数值数组。")
    duration = float(audit.get("durationSeconds", times[-1]))
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("连续音高的分析时长无效。")
    thresholds = audit.get("thresholds", {})
    if not isinstance(thresholds, dict):
        raise ValueError("独立核对的发声阈值无效。")
    periodicity_threshold = float(thresholds.get("periodicity", .3))
    activation_threshold = float(thresholds.get("fcpeActivation", .03))
    if not all(math.isfinite(value) and 0 <= value <= 1 for value in (periodicity_threshold, activation_threshold)):
        raise ValueError("独立核对的发声阈值无效。")
    return audit, arrays, duration, integrity, periodicity_threshold, activation_threshold


def read_pitch_window(directory: Path, start: float, end: float) -> dict:
    if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
        raise ValueError("请选择有效的原音频时间范围。")
    if end - start > MAX_WINDOW_SECONDS:
        raise ValueError("音高对照每次最多显示24秒，请缩小范围。")
    audit, arrays, duration, integrity, periodicity_threshold, activation_threshold = _read_contours(directory)
    if start >= duration:
        raise ValueError("所选时间超出已核对的分析段。")
    times = arrays["time"]
    end = min(end, duration)
    indices = np.flatnonzero((times >= start) & (times <= end))
    if len(indices) > 2500:
        raise ValueError("当前时间范围包含过多音高帧，请缩小范围。")
    frames = []
    for index in indices:
        audible = bool(arrays["audible"][index])
        activation = float(arrays["activation"][index])
        periodicity = float(arrays["periodicity"][index])
        values = []
        for field, voiced in (
            ("fcpeF0", audible and activation >= activation_threshold),
            ("crepeF0", audible and periodicity >= periodicity_threshold),
        ):
            frequency = float(arrays[field][index])
            midi = 69 + 12 * math.log2(frequency / 440) if voiced and math.isfinite(frequency) and frequency > (55 if field == "fcpeF0" else 0) else None
            values.append(round(midi, 3) if midi is not None and 0 <= midi <= 127 else None)
        frames.append({"seconds": round(float(times[index]), 4), "fcpeMidi": values[0], "crepeMidi": values[1], "audible": audible})
    return {
        "jobId": directory.name,
        "startSeconds": start,
        "endSeconds": end,
        "durationSeconds": duration,
        "frameStepSeconds": round(float(np.median(np.diff(times))), 6),
        "frames": frames,
        "integrity": integrity,
        "inputSource": audit.get("inputSource", "separated_lead"),
        "method": "Stored FCPE and independent CREPE on the selected vocal waveform; voiced/energy gates retained",
        "groundTruthAvailable": False,
        "note": "两条线是当前选定人声的模型证据，不是正确答案或歌手身份确认。空白表示低发声证据或静音，不应自动补音；保留原调。",
    }


def read_pitch_coverage(directory: Path) -> dict:
    from .voice_coverage import summarize_coverage

    _, arrays, duration, integrity, periodicity, activation = _read_contours(directory)
    return {
        "jobId": directory.name,
        "integrity": integrity,
        **summarize_coverage(arrays, duration, periodicity, activation),
    }

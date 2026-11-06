"""Rebuild only a saved source score's vocal notes, without reseparating audio."""
from __future__ import annotations

import copy
import hashlib
import json
import math
import re
import shutil
from pathlib import Path

from .storage import JOB_ID, JobStatus, atomic_json, read_json, utc_now

MAX_REQUEST_BYTES = 30 * 1024 * 1024
STEM_URL = re.compile(r"/api/audio/([a-f0-9]{32})/(stem-(?:lead|vocals)\.wav)")
LOCAL_ASSET_URL = re.compile(
    r"(?:/api/audio/[a-f0-9]{32}/(?:original|analysis|stem-(?:vocals|lead|backing|bass|drums|other|guitar|piano))\.wav"
    r"|/api/source/[a-f0-9]{32}|/api/projects/[a-f0-9]{32}/(?:raw|evidence)"
    r"|/api/omr/jobs/[a-f0-9]{32}/pages/[1-9][0-9]{0,2}|local:bundle-[a-f0-9-]+)"
)


def safe_file(root: Path, path: Path) -> Path:
    """Require an existing regular file under root without any symlink component."""
    root = root.absolute()
    path = path.absolute()
    try:
        relative = path.relative_to(root)
        path.resolve().relative_to(root.resolve())
    except ValueError as error:
        raise ValueError("音轨或证据路径不属于本机工程目录。") from error
    if root.is_symlink() or any((root / Path(*relative.parts[:i])).is_symlink() for i in range(1, len(relative.parts) + 1)):
        raise ValueError("音轨或证据路径不能包含符号链接。")
    if not path.is_file():
        raise ValueError("本机原始音轨或证据已不存在，请保留原工程音频后再试。")
    return path


def _finite(value, low=None, high=None) -> bool:
    return (type(value) in (int, float) and math.isfinite(value)
            and (low is None or value >= low) and (high is None or value <= high))


def validate_snapshot(project: dict) -> dict:
    """Validate bounded canonical score essentials, preserve all extra metadata."""
    if not isinstance(project, dict):
        raise ValueError("project 必须是有效的源乐谱工程。")
    try:
        encoded = json.dumps(project, allow_nan=False, ensure_ascii=False)
    except (TypeError, ValueError, RecursionError) as error:
        raise ValueError("工程包含非有限数值或无效 JSON。") from error
    if len(encoded.encode("utf-8")) > MAX_REQUEST_BYTES:
        raise ValueError("工程超过 30 MB 安全上限。")
    project = copy.deepcopy(project)
    # Results are consumed directly by the client. Do not retain an external
    # playback/page URL even though the worker never opens caller-owned paths.
    asset_urls = [part.get("stemUrl") for part in project.get("parts", []) if isinstance(part, dict) and "stemUrl" in part] if isinstance(project.get("parts"), list) else []
    source_assets = project.get("source") if isinstance(project.get("source"), dict) else {}
    pages = source_assets.get("pages", [])
    if not isinstance(pages, list):
        raise ValueError("原始谱页引用无效。")
    asset_urls.extend(pages)
    audio_assets = project.get("originalAudio") if isinstance(project.get("originalAudio"), dict) else {}
    asset_urls.extend(audio_assets[key] for key in ("url", "fileUrl") if key in audio_assets)
    analysis_assets = source_assets.get("analysis") if isinstance(source_assets.get("analysis"), dict) else {}
    quality_assets = analysis_assets.get("quality") if isinstance(analysis_assets.get("quality"), dict) else {}
    asset_urls.extend(value for key, value in quality_assets.items() if key.lower().endswith("url"))
    if any(not isinstance(url, str) or not LOCAL_ASSET_URL.fullmatch(url) for url in asset_urls):
        raise ValueError("源乐谱包含非本机音频或谱页链接；仅支持本机已保存的媒体引用。")
    if project.get("version") != 1 or not isinstance(project.get("id"), str):
        raise ValueError("工程版本或编号无效。")
    if any(not isinstance(project.get(key), str) for key in ("title", "composer", "key", "createdAt", "updatedAt")):
        raise ValueError("工程标题、调性或元数据无效。")
    if "arrangement" in project:
        raise ValueError("请切回源乐谱再重建主唱；合唱编配不能作为原音频转写源。")
    if not _finite(project.get("tempo"), 10, 500) or type(project.get("measures")) is not int or not 1 <= project["measures"] <= 2048:
        raise ValueError("工程速度或小节数无效。")
    signature = project.get("timeSignature")
    if not isinstance(signature, list) or len(signature) != 2 or any(type(v) is not int for v in signature) or not 1 <= signature[0] <= 32 or signature[1] not in (1, 2, 4, 8, 16, 32):
        raise ValueError("工程拍号无效。")
    limit = project["measures"] * signature[0] * 4 / signature[1]
    parts, chords = project.get("parts"), project.get("chords")
    if not isinstance(parts, list) or not 1 <= len(parts) <= 32 or not isinstance(chords, list) or len(chords) > 100000:
        raise ValueError("工程声部或和弦列表无效。")
    ids, total = set(), 0
    for part in parts:
        if not isinstance(part, dict) or not isinstance(part.get("id"), str) or part["id"] in ids or not isinstance(part.get("notes"), list):
            raise ValueError("工程声部编号或音符列表无效。")
        ids.add(part["id"])
        for key in ("name", "shortName", "instrument", "color"):
            if not isinstance(part.get(key), str):
                raise ValueError("工程声部信息无效。")
        if (part.get("role") not in ("lead", "harmony", "bass", "percussion", "instrument")
                or part.get("clef") not in ("treble", "bass", "alto", "percussion")
                or type(part.get("program")) is not int or not 0 <= part["program"] <= 127
                or any(type(part.get(key)) is not bool for key in ("muted", "solo"))
                or not _finite(part.get("volume"), 0, 1)):
            raise ValueError("工程声部乐器或混音信息无效。")
        note_ids = set()
        total += len(part["notes"])
        for note in part["notes"]:
            if (not isinstance(note, dict) or not isinstance(note.get("id"), str) or note["id"] in note_ids
                    or not _finite(note.get("start"), 0) or not _finite(note.get("duration"), .000001, 8192)
                    or note["start"] + note["duration"] > limit + .005 or not _finite(note.get("velocity"), 0, 1)
                    or "midi" not in note or (note["midi"] is not None and (type(note["midi"]) is not int or not 0 <= note["midi"] <= 127))
                    or ("lyric" in note and not isinstance(note["lyric"], str))):
                raise ValueError("工程音符编号、音高或时值无效。")
            note_ids.add(note["id"])
    if total > 100000 or "vocals" not in ids:
        raise ValueError("源乐谱必须包含 vocals 主唱声部，且最多 100000 个音符。")
    for chord in chords:
        if (not isinstance(chord, dict) or not isinstance(chord.get("symbol"), str)
                or not _finite(chord.get("start"), 0) or not _finite(chord.get("duration"), .000001)
                or chord["start"] + chord["duration"] > limit + .005
                or not isinstance(chord.get("pitches"), list) or not 1 <= len(chord["pitches"]) <= 128
                or any(type(pitch) is not int or not 0 <= pitch <= 127 for pitch in chord["pitches"])):
            raise ValueError("工程和弦数据无效。")
    source, audio = project.get("source"), project.get("originalAudio")
    if not isinstance(source, dict) or source.get("kind") != "audio" or not isinstance(source.get("warnings"), list) or any(not isinstance(w, str) for w in source["warnings"]):
        raise ValueError("仅支持保留原始音频的源乐谱。")
    analysis = source.get("analysis")
    if (not isinstance(analysis, dict) or not isinstance(analysis.get("transforms"), list)
            or any(not isinstance(t, str) for t in analysis["transforms"])
            or not isinstance(analysis.get("quality", {}), dict)):
        raise ValueError("工程音频分析来源无效。")
    if (not isinstance(audio, dict) or not isinstance(audio.get("url"), str)
            or not _finite(audio.get("duration"), .000001) or not _finite(audio.get("offsetSeconds"), -86400, 86400)
            or not _finite(audio.get("tempo"), 10, 500)):
        raise ValueError("需要原音频的有效 tempo 与 offsetSeconds，不能使用练习速度推测原始节拍。")
    return project


def prepare_rebuild(root: Path, source_id: str, snapshot: dict) -> tuple[dict, dict, Path, Path]:
    if not JOB_ID.fullmatch(source_id):
        raise ValueError("源任务编号无效。")
    project = validate_snapshot(snapshot)
    source_dir = root / source_id
    state = read_json(safe_file(root, source_dir / "status.json"))
    stored = state.get("project")
    if state.get("status") != "complete" or not isinstance(stored, dict) or (source_dir / "cancelled").exists():
        raise ValueError("仅可重建已经完成的原音频转写。")
    if project["source"]["analysis"].get("rawProjectUrl") != f"/api/projects/{source_id}/raw":
        raise ValueError("当前源乐谱与所选任务不匹配，请重新打开该源结果。")
    original = stored.get("originalAudio") or {}
    if (project["originalAudio"]["url"] != original.get("url") or not re.fullmatch(r"/api/audio/[a-f0-9]{32}/original\.wav", str(original.get("url", "")))):
        raise ValueError("原音频 URL 与保存的源工程不匹配。")
    if (project["originalAudio"]["offsetSeconds"] != original.get("offsetSeconds")
            or project["originalAudio"]["duration"] != original.get("duration")
            or project["source"].get("analysisStartSeconds") != stored.get("source", {}).get("analysisStartSeconds")
            or any("插入小节后" in text for text in project["source"]["warnings"])):
        raise ValueError("乐谱时间线已插入小节或改变原音频映射，无法安全重建主唱；请打开未移动时间线的源乐谱。")
    old_rhythm = stored.get("source", {}).get("analysis", {}).get("rhythm") or {}
    rhythm = project["source"]["analysis"].get("rhythm") or {}
    if not isinstance(rhythm, dict) or rhythm.get("offsetSeconds") != old_rhythm.get("offsetSeconds"):
        raise ValueError("节拍时间线偏移已改变，无法安全映射原音频。")
    source_vocals = next((part for part in stored.get("parts", []) if part.get("id") == "vocals"), {})
    snapshot_vocals = next(part for part in project["parts"] if part["id"] == "vocals")
    if snapshot_vocals.get("stemUrl") != source_vocals.get("stemUrl"):
        raise ValueError("当前主唱音轨引用与保存的源工程不匹配。")
    match = STEM_URL.fullmatch(str(source_vocals.get("stemUrl", "")))
    if not match:
        raise ValueError("原工程没有可复用的本地主唱音轨；请先完成带分轨的原音频转写。")
    stem = safe_file(root, root / match[1] / match[2])
    safe_file(root, source_dir / "raw-project.json")
    # Never use the caller's stem URL as an input path.
    return project, stored, stem, source_dir


def _copy_prior_dense(root: Path, source_dir: Path, stem: Path, target: Path, evidence: dict, require_audio_binding: bool = False) -> bool:
    from .pitch_evidence import _read_contours
    prior_path = source_dir / "quality-evidence.json"
    if not prior_path.exists():
        return _copy_prior_dense(root, stem.parent, stem, target, evidence, require_audio_binding) if source_dir != stem.parent else False
    prior = read_json(safe_file(root, prior_path))
    audit = prior.get("denseVoiceAudit")
    if not isinstance(audit, dict) or not audit.get("contourFile"):
        return _copy_prior_dense(root, stem.parent, stem, target, evidence, require_audio_binding) if source_dir != stem.parent else False
    # Existing reader checks local containment, archive bounds and contour hash.
    _, _, _, source_integrity, _, _ = _read_contours(source_dir)
    contour = Path(audit["contourFile"])
    if not contour.is_absolute():
        contour = source_dir / contour
    contour = safe_file(root, contour)
    cache_path = contour.parent / "cache.json"
    cache = read_json(safe_file(root, cache_path)) if cache_path.exists() else {}
    signature = cache.get("signature") or {}
    # Earlier derived scores retained only contour integrity. Recover full
    # audio binding from the original authoritative stem directory if present.
    bound = bool(signature.get("leadSha256") and cache.get("reportSha256"))
    if not bound and require_audio_binding:
        return False
    if not bound and source_dir != stem.parent and _copy_prior_dense(root, stem.parent, stem, target, evidence, True):
        return True
    contour_hash = hashlib.sha256(contour.read_bytes()).hexdigest()
    report = None
    if bound:
        lead_hash = hashlib.sha256(stem.read_bytes()).hexdigest()
        if signature.get("leadSha256") != lead_hash or cache.get("contourSha256") != contour_hash:
            raise ValueError("原主唱连续音高证据与当前音轨哈希不匹配，未复用。")
        report = safe_file(root, contour.parent / "report.json")
        if cache.get("reportSha256") != hashlib.sha256(report.read_bytes()).hexdigest():
            raise ValueError("原独立音高报告哈希不匹配，未复用。")
    output = target / "dense-voice-audit" / "prior"
    output.mkdir(parents=True)
    shutil.copyfile(contour, output / contour.name)
    if bound:
        for path in (report, cache_path):
            shutil.copyfile(path, output / path.name)
    else:
        # Preserve the readable legacy curves without retroactively inventing
        # an audio signature that the earlier run never recorded.
        atomic_json(output / "cache.json", {"contourSha256": contour_hash, "copiedFromJob": source_dir.name,
                                           "sourceIntegrity": source_integrity, "audioBindingVerified": False})
    copied = copy.deepcopy(audit)
    copied.update(contourFile="dense-voice-audit/prior/contours.npz", cacheHit=True, reusedFromJob=source_dir.name,
                  verificationRerun=False, validatesCurrentNotes=False, audioBindingVerified=bound,
                  priorIntegrity=source_integrity)
    evidence["denseVoiceAudit"] = copied
    return True


def rebuild_vocals(directory: Path, request: dict, status: JobStatus) -> dict:
    from .rosvot import infer_rosvot
    from .vocal_score import quantize_vocal_rhythm
    import soundfile as sf

    root = directory.parent
    status.update(5, "vocal-source", "正在核对已保存的主唱音轨与源乐谱，不重新分轨。")
    project, stored, stem, source_dir = prepare_rebuild(root, request["source_job_id"], request["project"])
    atomic_json(directory / "previous-project.json", project)
    shutil.copyfile(safe_file(root, source_dir / "raw-project.json"), directory / "raw-project.json")
    duration = float(sf.info(stem).duration)
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("保存的主唱音轨时长无效。")
    status.update(20, "vocal-notes", "正在用原主唱音轨重建词与音符边界。")
    learned = infer_rosvot(stem, directory / "vocal-note-model", timeout_seconds=max(180., duration * 3), cancel_check=status.check_cancelled)
    status.check_cancelled()
    events = learned["events"]
    alignment = {"version": "not_available", "boundaryEdits": [], "reason": "No stored FCPE contour"}
    contour = stem.parent / ("lead-identity/lead-models/vocals-fcpe.npz" if stem.name == "stem-lead.wav" else "quality-models/vocals-fcpe.npz")
    status.update(70, "vocal-alignment", "正在按保存的音高进入与收音证据对齐边界。")
    if contour.exists() or contour.is_symlink():
        import numpy as np
        from .vocal_alignment import align_vocal_notes
        from .lead_note_proposal import frame_acoustic_evidence
        contour = safe_file(root, contour)
        with np.load(contour, allow_pickle=False) as comparison:
            audio, sr = sf.read(stem, dtype="float32", always_2d=True)
            features = frame_acoustic_evidence(comparison["time"], audio.mean(axis=1), sr)
            events, alignment = align_vocal_notes(events, comparison["time"], comparison["f0"], comparison["activation"], features)
    status.update(85, "vocal-rhythm", "正在联合整理主唱起止与真实换气，保留其他声部和编辑。")
    predicted = [[event["source_start_seconds"], event["source_end_seconds"], event["midi_pitch"], .75] for event in events if event["midi_pitch"] is not None]
    bpm = project["originalAudio"]["tempo"]
    # The score quantizer's acoustic range is 20–300; beat reinterpretation can
    # legitimately reach 10–500. Work in an equivalent beat unit then rescale.
    quantizer_bpm = bpm * 2 if bpm < 20 else bpm / 2 if bpm > 300 else bpm
    grid = {"bpm": quantizer_bpm, "offsetSeconds": project["originalAudio"]["offsetSeconds"]}
    notes, rhythm = quantize_vocal_rhythm(predicted, grid, duration, "vocals", preserve_confidence=False)
    if quantizer_bpm != bpm:
        for note in notes:
            note["start"] = round(note["start"] * bpm / quantizer_bpm, 6)
            note["duration"] = round(note["duration"] * bpm / quantizer_bpm, 6)
        rhythm["beatUnitScale"] = bpm / quantizer_bpm
    if not notes:
        raise ValueError("词音模型未生成可用主唱音符，保留原工程；没有创建空白替换。")
    vocals = next(part for part in project["parts"] if part["id"] == "vocals")
    before = sum(note["midi"] is not None for note in vocals["notes"])
    vocals["notes"] = notes
    bar = project["timeSignature"][0] * 4 / project["timeSignature"][1]
    project["measures"] = max(project["measures"], math.ceil(max(n["start"] + n["duration"] for n in notes) / bar - 1e-9))
    if project["measures"] > 2048:
        raise ValueError("重建后的乐谱超过 2048 小节上限。")
    project["id"] = directory.name
    project["updatedAt"] = utc_now()
    analysis = project["source"]["analysis"]
    analysis["rawProjectUrl"] = f"/api/projects/{directory.name}/raw"
    quality = analysis.setdefault("quality", {})
    quality.update(vocalRebuildFromJob=source_dir.name, beforeVocalNotes=before, afterVocalNotes=len(notes),
                   decoderProfile="rosvot", decoderVersion="rosvot-rwbd-acoustic-alignment-score-2", vocalAlignmentVersion=alignment["version"],
                   vocalAlignedBoundaries=len(alignment["boundaryEdits"]), vocalRhythmVersion=rhythm["version"],
                   vocalRhythmChangedBoundaries=sum(abs(row["scoreStartSeconds"] - row["sourceStartSeconds"]) > 1e-6 or abs(row["scoreEndSeconds"] - row["sourceEndSeconds"]) > 1e-6 for row in rhythm["boundaryChanges"]),
                   modelEvidenceUrl=f"/api/projects/{directory.name}/evidence", verificationRerun=False,
                   verificationStatus="prior_cached", vocalNotesVerified=False)
    evidence = {"vocalRebuildFromJob": source_dir.name, "sourceStemUrl": next(p for p in stored["parts"] if p["id"] == "vocals")["stemUrl"],
                "parts": {"vocals": {"decoderUsed": "rosvot", "learnedVocalNotes": learned, "alignedVocalEvents": events,
                                      "vocalBoundaryAlignment": alignment, "scoreRhythm": rhythm}},
                "verificationRerun": False, "validatesCurrentNotes": False}
    status.update(95, "vocal-evidence", "正在保存独立的新结果，并复用已校验的原音高证据。")
    try:
        copied = _copy_prior_dense(root, source_dir, stem, directory, evidence)
    except (OSError, ValueError, KeyError, TypeError) as error:
        # A missing/corrupt optional prior audit must never masquerade as a new
        # verification pass or prevent a valid new vocal transcription.
        copied = False
        quality["priorPitchEvidenceError"] = str(error)
        evidence["priorPitchEvidenceRejected"] = str(error)
    quality["priorPitchEvidenceAvailable"] = copied
    if copied:
        quality["priorPitchAudioBindingVerified"] = evidence["denseVoiceAudit"]["audioBindingVerified"]
    if not copied:
        quality["verificationStatus"] = "not_rerun"
    warning = "本次仅从原音轨重建主唱音符与节奏，替换原主唱歌词；未重跑独立核对。已有FCPE/CREPE曲线仅为原音频证据，不验证本次新音符正确。"
    if warning not in project["source"]["warnings"]:
        project["source"]["warnings"].append(warning)
    if warning not in analysis["transforms"]:
        analysis["transforms"].append(warning)
    from .audio_quality import note_quality
    quality.update(note_quality(project["parts"]))
    status.check_cancelled()
    atomic_json(directory / "quality-evidence.json", evidence)
    atomic_json(directory / "project.json", project)
    return project

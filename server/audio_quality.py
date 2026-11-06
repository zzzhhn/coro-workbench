from __future__ import annotations

import copy
import json
import logging
import math
import subprocess
import time
import os
from pathlib import Path

import numpy as np
import soundfile as sf

from . import config
from .rhythm import fit_beat_grid, quantize_on_grid
from .storage import Cancelled, JobStatus, atomic_json, read_json
from .vocal_decode import DECODER_VERSIONS, decode_selected_contour


def quality_engine_ready() -> bool:
    root = config.MODELS_DIR / "audio-quality"
    return (root / ".venv/bin/python").is_file() and (root / "beat-this-final0.ckpt").is_file()


def _upgrade_identity_evidence(result: dict, output: Path) -> dict:
    if "usablePartial" in result or not result.get("leadVerification"):
        return result
    rows = result["leadVerification"].get("intervals", [])
    result["usablePartial"] = any(row.get("comparedFrames", 0) >= 40 and (row.get("over6Semitones") or 0) <= .25 for row in rows)
    result["uncertaintyIntervals"] = [{"partId": "vocals", "startSeconds": row["startSeconds"], "endSeconds": row["startSeconds"] + row["durationSeconds"], "reason": "Lead branch FCPE/CREPE octave or voice identity disagreement", "alternatives": ["KARA2 lead FCPE contour", "CREPE sampled lead contour", "original polyphonic Basic Pitch candidates"]} for row in rows if row.get("comparedFrames", 0) >= 40 and (row.get("over6Semitones") or 0) > .25]
    result["sampledAlternativeContours"] = []
    for path in (output / "lead-models").glob("voice-check-*.npz"):
        values = np.load(path)
        result["sampledAlternativeContours"].append({"timeSeconds": values["time"].tolist(), "crepeF0Hz": values["crepeF0"].tolist(), "periodicity": values["periodicity"].tolist(), "fcpeF0Hz": values["fcpeF0"].tolist()})
    return result


def note_quality(parts: list[dict]) -> dict:
    metrics = {}
    for part in parts:
        notes = [n for n in part["notes"] if n["midi"] is not None]
        points = sorted([(n["start"], 1) for n in notes] + [(n["start"] + n["duration"], -1) for n in notes])
        active = maximum = 0
        overlap = 0.
        previous = None
        for at, change in points:
            if previous is not None and active > 1:
                overlap += at - previous
            active += change
            maximum = max(maximum, active)
            previous = at
        metrics[f"{part['id']}.notes"] = len(notes)
        metrics[f"{part['id']}.maxPolyphony"] = maximum
        metrics[f"{part['id']}.sixteenthNotes"] = sum(n["duration"] <= .25 + 1e-8 for n in notes)
        metrics[f"{part['id']}.overlapBeats"] = round(overlap, 3)
    return metrics


def run_quality_models(directory: Path, paths: dict[str, Path], status: JobStatus | None = None) -> Path:
    destination = directory / "quality-models"
    destination.mkdir(parents=True, exist_ok=True)
    inputs = {"audio": str((directory / "analysis.wav").resolve())}
    for role in ("vocals", "bass", "piano"):
        if role in paths:
            inputs[role] = str(paths[role].resolve())
    atomic_json(destination / "inputs.json", inputs)
    cached = (destination / "models.json").is_file()
    need_verify = bool(inputs.get("vocals")) and not (destination / "voice-check.json").is_file()
    if cached and not need_verify:
        return destination
    if status:
        status.update(93, "quality", "正在生成节拍对齐、主唱旋律和钢琴踏板分离提案，原始模型结果会单独保留。")
    command = [str(config.MODELS_DIR / "audio-quality/.venv/bin/python"), str(config.ROOT / "server/quality_runner.py"), "--input", str((destination / "inputs.json").resolve()), "--models", str((config.MODELS_DIR / "audio-quality").resolve()), "--output", str(destination.resolve())]
    if cached:
        command.append("--verify-only")
    with (destination / "runner.log").open("w", encoding="utf-8") as log:
        process = subprocess.Popen(command, cwd=config.ROOT, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 1200
            while process.poll() is None:
                if status:
                    status.check_cancelled()
                if time.monotonic() > deadline:
                    raise ValueError("谱面整理模型运行超时，原始结果已保留。")
                time.sleep(.2)
            if process.returncode != 0 or not (destination / "models.json").is_file():
                raise ValueError("本地谱面整理模型失败，原始模型结果已保留。")
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
    return destination


def refine_vocal_identity(directory: Path, model_dir: Path, vocal_path: Path, status: JobStatus | None = None) -> dict:
    model = config.MODELS_DIR / "lead-separation/kara2.onnx"
    if not model.is_file():
        return {"available": False, "reason": "Lead/backing identity model not installed; dominant mixed-vocal line only"}
    output = directory / "lead-identity"
    output.mkdir(parents=True, exist_ok=True)
    result_path = output / "identity.json"
    if result_path.is_file():
        result = _upgrade_identity_evidence(read_json(result_path), output)
        atomic_json(result_path, result)
        return result
    if status:
        status.update(94, "vocal-identity", "正在单独分离主唱/伴唱，并用独立音高模型复核；原始人声仍保留。")
    from .lead_separation import separate_lead_backing
    separation = separate_lead_backing(vocal_path, model, output, check_cancelled=status.check_cancelled if status else None)
    for name in ("lead", "backing"):
        destination = directory / f"stem-{name}.wav"
        if not destination.exists():
            os.link(output / f"{name}.wav", destination)
    identity_inputs = output / "inputs.json"
    atomic_json(identity_inputs, {"vocals": str((directory / "stem-lead.wav").resolve())})
    command = [str(config.MODELS_DIR / "audio-quality/.venv/bin/python"), str(config.ROOT / "server/quality_runner.py"), "--input", str(identity_inputs.resolve()), "--models", str((config.MODELS_DIR / "audio-quality").resolve()), "--output", str((output / "lead-models").resolve())]
    with (output / "verification.log").open("w", encoding="utf-8") as log:
        process = subprocess.Popen(command, cwd=config.ROOT, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 600
            while process.poll() is None:
                if status:
                    status.check_cancelled()
                if time.monotonic() > deadline:
                    return {"available": True, "separation": separation, "accepted": False, "reason": "Lead F0 verification timed out; mixed-vocal candidates retained"}
                time.sleep(.2)
            if process.returncode != 0:
                return {"available": True, "separation": separation, "accepted": False, "reason": "Lead F0 verification failed; mixed-vocal candidates retained"}
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
    check = read_json(output / "lead-models/voice-check.json")
    original_check = read_json(model_dir / "voice-check.json") if (model_dir / "voice-check.json").exists() else None
    uncertain = [{"partId": "vocals", "startSeconds": row["startSeconds"], "endSeconds": row["startSeconds"] + row["durationSeconds"], "reason": "Lead branch FCPE/CREPE octave or voice identity disagreement", "alternatives": ["KARA2 lead FCPE contour", "CREPE sampled lead contour", "original polyphonic Basic Pitch candidates"]} for row in check.get("intervals", []) if row.get("comparedFrames", 0) >= 40 and (row.get("over6Semitones") or 0) > .25]
    usable_partial = any(row.get("comparedFrames", 0) >= 40 and (row.get("over6Semitones") or 0) <= .25 for row in check.get("intervals", []))
    alternatives = []
    for path in (output / "lead-models").glob("voice-check-*.npz"):
        values = np.load(path)
        alternatives.append({"timeSeconds": values["time"].tolist(), "crepeF0Hz": values["crepeF0"].tolist(), "periodicity": values["periodicity"].tolist(), "fcpeF0Hz": values["fcpeF0"].tolist()})
    result = {"available": True, "accepted": not check.get("abstain", True), "usablePartial": usable_partial, "uncertaintyIntervals": uncertain, "sampledAlternativeContours": alternatives, "separation": separation, "originalVerification": original_check, "leadVerification": check, "leadContour": str((output / "lead-models/vocals-fcpe.npz").resolve()), "leadAudio": "stem-lead.wav", "backingAudio": "stem-backing.wav", "reason": "Lead-target separator hypothesis independently pitch-checked; uncertain sampled regions remain marked, unsampled regions unverified"}
    atomic_json(result_path, result)
    return result


def remove_pedal_overlap(events: list, pedals: list[dict]) -> tuple[list, int]:
    """Editorial finger-duration proposal, not inferred physical key releases."""
    result = [list(event) for event in sorted(events, key=lambda event: (event[0], event[2]))]
    changes = 0
    for event in result:
        onset, offset, pitch = event[:3]
        if not any(p["onset_time"] - .35 <= onset <= p["offset_time"] and offset >= p["onset_time"] for p in pedals):
            continue
        hand = 0 if pitch < 60 else 1
        next_onset = next((candidate[0] for candidate in result if candidate[0] > onset + .085 and (0 if candidate[2] < 60 else 1) == hand), None)
        if next_onset is not None and next_onset < offset - .08:
            event[1] = max(onset + .075, next_onset)
            changes += 1
    return result, changes


def piano_onset_consensus(measured: list, baseline: list, tolerance: float = .12) -> tuple[list, dict]:
    """Conservative proposal, with all disagreements retained as review evidence."""
    agreed = []
    uncertain = []
    used = set()
    for note in sorted(measured, key=lambda event: (event[0], event[2])):
        matches = [(index, candidate) for index, candidate in enumerate(baseline) if index not in used and candidate[2] == note[2] and abs(candidate[0] - note[0]) <= tolerance]
        if matches:
            index, _ = min(matches, key=lambda item: abs(item[1][0] - note[0]))
            used.add(index)
            agreed.append(note)
        else:
            uncertain.append({"model": "piano_crnn", "event": note, "reason": "no_matching_basic_pitch_onset"})
    uncertain.extend({"model": "basic_pitch", "event": note, "reason": "no_matching_piano_crnn_onset"} for index, note in enumerate(baseline) if index not in used)
    return agreed, {"onsetToleranceSeconds": tolerance, "agreedEvents": len(agreed), "crnnEvents": len(measured), "basicPitchEvents": len(baseline), "reviewCandidates": uncertain, "reviewCandidateCount": len(uncertain), "statement": "Model agreement is not ground-truth correctness. Unmatched events retained, not asserted false."}


def merge_unsupported_retriggers(events: list, audio: np.ndarray, sr: int) -> tuple[list, list[dict]]:
    """Merge same-pitch continuation only with weak onset and decaying local RMS."""
    result, previous, edits = [], {}, []
    for original in sorted(events, key=lambda event: (event[0], event[2])):
        event = list(original)
        if len(event) < 4:
            continue
        start, end, pitch, strength = event[:4]
        old = previous.get(pitch)
        if old and -.025 <= start - old[1] <= .07 and strength < .60:
            frame = int(start * sr)
            win = max(1, int(.035 * sr))
            before = audio[max(0, frame - win):frame]
            after = audio[frame:min(len(audio), frame + win)]
            if len(before) and len(after) and float(np.mean(after ** 2)) <= float(np.mean(before ** 2)) * 1.06:
                old[1] = max(old[1], end)
                edits.append({"action": "merged_same_pitch_decay", "pitch": pitch, "atSeconds": start, "activation": strength})
                continue
        result.append(event)
        previous[pitch] = event
    return result, edits


def infer_accompaniment_chords(parts: list[dict], total_beats: float) -> list[dict]:
    from .pipeline import infer_chords
    accompaniment = [p for p in parts if p["role"] not in {"percussion", "lead"} and p["id"] != "other"]
    if not any(p["notes"] for p in accompaniment):
        return []
    # Existing harmonic templates now see accompaniment, not melody + duplicated residual votes.
    return infer_chords(accompaniment, total_beats)


def improve_project(directory: Path, raw_project: dict, request: dict, paths: dict[str, Path], raw_events: dict, status: JobStatus | None = None) -> dict:
    model_dir = run_quality_models(directory, paths, status)
    evidence = read_json(model_dir / "models.json")
    rhythm = np.load(model_dir / "rhythm.npz")
    grid = fit_beat_grid(rhythm["beats"], rhythm["downbeats"], raw_project["tempo"], request.get("tempo"))
    project = copy.deepcopy(raw_project)
    project["tempo"] = grid["bpm"]
    duration = sf.info(directory / "analysis.wav").duration
    project["originalAudio"]["tempo"] = grid["bpm"]
    project["originalAudio"]["offsetSeconds"] = grid["offsetSeconds"]
    transforms = ["Beat This! 独立检测拍点/强拍，并稳健拟合恒定网格；首个强拍前的音频保留为弱起/前置小节。", "量化基于检测到的节拍相位，不再把音频0秒当作第一拍。原始推断音符另存。"]
    detailed = {"schemaVersion": 1, "disclaimer": "Model measurements and reversible editorial proposals, not ground-truth transcription or user acceptance.", "grid": grid, "engines": evidence, "parts": {}, "beforeMetrics": note_quality(raw_project["parts"])}
    identity = None
    if "vocals" in paths and request.get("lead_identity", "auto") != "off":
        identity = refine_vocal_identity(directory, model_dir, paths["vocals"], status)
        detailed["leadIdentity"] = identity
    for part in project["parts"]:
        part_id = part["id"]
        old = next(p for p in raw_project["parts"] if p["id"] == part_id)
        # Start from the existing visible event set so a later pass does not resurrect
        # notes the baseline already rejected as inaudible or octave harmonics.
        old_bpm = raw_project["tempo"]
        old_offset = raw_project.get("originalAudio", {}).get("offsetSeconds", 0)
        visible_events = [[n["start"] * 60 / old_bpm + old_offset, (n["start"] + n["duration"]) * 60 / old_bpm + old_offset, n["midi"], n.get("confidence", n["velocity"])] for n in old["notes"] if n["midi"] is not None]
        raw_candidates = raw_events.get(part_id)
        events = []
        used = set()
        for visible in visible_events:
            matches = [(index, candidate) for index, candidate in enumerate(raw_candidates or []) if isinstance(raw_candidates, list) and index not in used and candidate[2] == visible[2] and abs(candidate[0] - visible[0]) <= max(.09, 60 / old_bpm / 7)]
            if matches:
                index, candidate = min(matches, key=lambda item: abs(item[1][0] - visible[0]))
                used.add(index)
                events.append(list(candidate))
            else:
                events.append(visible)
        details = {"inputEvents": len(events), "method": "same-pitch acoustic continuation consolidation"}
        monophonic = False
        if part_id in {"vocals", "bass"} and (model_dir / f"{part_id}-fcpe.npz").is_file():
            accepted_identity = part_id == "vocals" and identity and (identity.get("accepted") or identity.get("usablePartial"))
            contour_path = Path(identity["leadContour"]) if accepted_identity else model_dir / f"{part_id}-fcpe.npz"
            audio_path = directory / "stem-lead.wav" if accepted_identity else paths[part_id]
            track = np.load(contour_path)
            audio, sr = sf.read(audio_path, dtype="float32", always_2d=True)
            contour_profile = request.get("decoder", "standard")
            if contour_profile == "rosvot":
                contour_profile = "acoustic"
            events, contour_info = decode_selected_contour(track["time"], track["f0"], track["activation"], audio.mean(axis=1), sr, part_id, contour_profile)
            if part_id == "vocals" and request.get("decoder", "standard") == "legato":
                transforms.append("按用户选择采用legato时长约束DP主唱解码（最短目标100ms、转换惩罚2），保留更多连续音高转折；这是更密的备选谱，不自动替代标准排练谱。")
            elif part_id == "vocals" and request.get("decoder") == "acoustic":
                transforms.append("按用户选择采用声学起止分段：结合FCPE、能量谷与频谱起音区分连音/同音再起。人审清唱留出集逐音F1改善，但不等于这首混音已准确；原始音高与基础谱保留。")
            details.update(contour_info)
            if part_id == "vocals":
                verification = identity["leadVerification"] if accepted_identity else read_json(model_dir / "voice-check.json") if (model_dir / "voice-check.json").exists() else {"abstain": True, "reason": "Independent verifier missing"}
                details["independentVerification"] = verification
                details["fcpeAlternativeEvents"] = events
                if identity and identity.get("available") and not accepted_identity:
                    verification = {**verification, "abstain": True, "reason": "Lead-target separation still ambiguous; original candidates retained"}
                    details["independentVerification"] = verification
                if accepted_identity:
                    if identity.get("usablePartial") and not identity.get("accepted"):
                        verification = {**verification, "abstain": False, "partial": True}
                        details["independentVerification"] = verification
                        details["uncertaintyIntervals"] = identity.get("uncertaintyIntervals", [])
                    part["stemUrl"] = f"/api/audio/{project['id']}/stem-lead.wav"
                    details["leadIdentityUsed"] = True
                    transforms.append("人声先由独立KARA2按主唱/伴唱目标分离，再对主唱分支做FCPE/CREPE复核；主唱谱试听使用lead音频，原vocals与backing仍可对照，不把低八度伴唱误当唯一主唱。")
                if verification.get("abstain", True):
                    events = visible_events
                    part["name"] = "主唱候选 · 未确定"
                    part["roleSource"] = "model"
                    details["abstained"] = True
                    transforms.append("主唱独立CREPE抽样与FCPE在八度/声部上分歧过大或证据不足：不默认采用单旋律替换，保留基础候选；FCPE备选逐音数组及分歧时间段可在模型证据下载。")
            if events:
                monophonic = not details.get("abstained", False)
                if monophonic:
                    part["name"] = ("主唱提案 · 局部待定" if identity and not identity.get("accepted") and accepted_identity else "主唱旋律提案") if part_id == "vocals" else "低音旋律提案"
                part["roleSource"] = "model"
                if monophonic:
                    transforms.append(f"{part['name']}：FCPE连续音高+发声/静音分段，按主导单旋律解码；多重人声/低音和弦保留在原始结果，不视作错误删除。")
            else:
                events = visible_events
                details["fallback"] = "No stable FCPE phrase; raw model events retained"
        elif part_id == "piano" and (model_dir / "piano.json").is_file():
            piano = read_json(model_dir / "piano.json")
            measured = [n for n in piano["notes"] if n[1] - n[0] >= .06 and 21 <= n[2] <= 108]
            if measured:
                agreed, consensus = piano_onset_consensus(measured, raw_candidates if isinstance(raw_candidates, list) else visible_events)
                # An empty consensus is an abstention, not an empty replacement score.
                if agreed:
                    events, count = remove_pedal_overlap(agreed, piano["pedals"])
                else:
                    events, count = visible_events, 0
                    consensus["fallback"] = "No model agreement; baseline retained for manual review"
                details.update(method="independent piano onset agreement + reversible pedal-duration proposal", newMeasuredNotes=len(measured), editorialFingerDurations=count, pedalEvents=len(piano["pedals"]), consensus=consensus)
                part["name"] = "钢琴 · 起音共识提案"
                part["clef"] = "treble"
                part["staves"] = [{"number": 1, "clef": "treble"}, {"number": 2, "clef": "bass"}]
                transforms.append(f"钢琴只在草稿采用两独立模型同音高/±120ms起音共识（{len(agreed)}音）；{consensus['reviewCandidateCount']}个不一致候选逐条保存在可下载模型分歧证据（含CRNN新增音），不是仅在BP原始工程内，不判为错音。{count}个踏板延音改记为下一次同手起音结束，是可撤回指法时值提案。")
        elif part_id in paths and part["role"] != "percussion":
            audio, sr = sf.read(paths[part_id], dtype="float32", always_2d=True)
            events, edits = merge_unsupported_retriggers(events, audio.mean(axis=1), sr)
            details["edits"] = edits
            if edits:
                transforms.append(f"{part['name']}：合并{len(edits)}个没有声学再起音、能量衰减的同音碎片，不设任意复音上限。")
        quantum = .125 if monophonic else .25
        learned_notes = None
        if part_id == "vocals" and request.get("decoder") == "rosvot":
            details["acousticAlternativeEvents"] = copy.deepcopy(events)
            try:
                from .rosvot import infer_rosvot
                from .vocal_score import quantize_vocal_rhythm
                target_audio = directory / "stem-lead.wav"
                if not target_audio.is_file():
                    target_audio = paths[part_id]
                if status:
                    status.update(95, "vocal-notes", "正在以词边界与音符边界模型重建主唱节奏，不把音高掉帧直接记成碎音。")
                learned = infer_rosvot(target_audio, directory / "vocal-note-model", timeout_seconds=max(180., duration * 3),
                                       cancel_check=(lambda: status.check_cancelled()) if status else None)
                predicted = [[event["source_start_seconds"], event["source_end_seconds"], event["midi_pitch"], .75]
                             for event in learned["events"] if event["midi_pitch"] is not None]
                # The model does not expose calibrated note confidence. 0.75 is
                # a playback velocity only, never a displayed correctness score.
                learned_notes, rhythm = quantize_vocal_rhythm(predicted, grid, duration, part_id, preserve_confidence=False)
                details["learnedVocalNotes"] = learned
                details["scoreRhythm"] = rhythm
                details["decoderUsed"] = "rosvot"
                details["abstained"] = False
                part["name"] = "主唱 · 词音节奏"
                part["roleSource"] = "model"
                if target_audio.name == "stem-lead.wav":
                    part["stemUrl"] = f"/api/audio/{project['id']}/stem-lead.wav"
                monophonic = True
                transforms.append("主唱由ROSVOT/RWBD学习词与音符边界，再联合整理相邻起止；保留真实重复起音与换气，原FCPE分段另存。未生成歌词，不把模型置信或曲线一致当正确率。")
            except Cancelled:
                raise
            except Exception as error:
                details["learnedVocalError"] = f"{type(error).__name__}: {error}"
                details["decoderUsed"] = "acoustic_fallback"
                transforms.append("词音节奏模型未成功完成，本次保留声学分段备选；没有宣称ROSVOT转写成功。详见learnedVocalError。")
        notes = learned_notes if learned_notes is not None else quantize_on_grid(events, grid, duration, part_id, monophonic=monophonic, preserve_confidence=part_id not in {"piano"}, quantum=quantum)
        if part_id == "piano":
            for note in notes:
                note["staff"] = 1 if note["midi"] >= 60 else 2
        if part["role"] == "percussion":
            for note in notes:
                note["duration"] = .25
                note["lyric"] = "dum" if note["midi"] in (35, 36) else "ka" if note["midi"] in (37, 38, 39, 40) else "ts"
        part["notes"] = notes
        details["outputNotes"] = len(notes)
        detailed["parts"][part_id] = details
    end = max((n["start"] + n["duration"] for p in project["parts"] for n in p["notes"]), default=0)
    project["measures"] = max(1, math.ceil(max(end, (duration - grid["offsetSeconds"]) * grid["bpm"] / 60) / 4))
    project["chords"] = infer_accompaniment_chords(project["parts"], project["measures"] * 4)
    detailed["symbolicHarmonyAlternative"] = copy.deepcopy(project["chords"])
    harmony_result = None
    harmony_error = None
    if any(name in paths for name in ("piano", "guitar", "bass", "other")):
        try:
            from .chordino import runtime_health
            if runtime_health()["ready"]:
                from .audio_harmony import accompaniment_harmony
                project["chords"], harmony_result = accompaniment_harmony(directory, paths, grid["bpm"], grid["offsetSeconds"], project["measures"] * 4, status)
                detailed["audioHarmony"] = harmony_result
                transforms.append("和弦直接来自分离伴奏的Chordino音频分析，保留七和弦/转位；变化点按四分之一拍整理。N无和弦段不自动填和弦，原声学时点和原符号法候选均保留，不代表已人工确认。")
            else:
                harmony_error = "Native Chordino runtime is not installed or its integrity check failed"
        except Cancelled:
            raise
        except Exception as error:
            harmony_error = f"{type(error).__name__}: {error}"
    if harmony_result is None:
        transforms.append("和弦使用伴奏与低音转写的符号法候选，不把主唱/other重复计票；音频和弦引擎未采用，仍需人工和声校对。")
        if harmony_error:
            detailed["audioHarmonyError"] = harmony_error
    transforms.append("采用单旋律解码的主唱/低音最短时值为三十二分音符，减少慢速下把短音和静音强行拉到十六分音符的过长尾音；这不代表所有装饰音/吐字已识别。")
    warnings = [w for w in project["source"]["warnings"] if not w.startswith("自动估计速度")]
    if harmony_result:
        warnings = [w for w in warnings if not w.startswith("和弦按每小节")]
        warnings.append("和弦来自分离伴奏的Chordino音频候选；N表示未辨识到和弦，不保证真正无和声。挂留/减七与串音仍可能误判，允许编辑后重新编配。")
    warnings.extend(["当前为整理提案。主唱单旋律、去踏板延音和节拍重排不是人工确认的原曲总谱，可打开原始模型结果逐项对照。", f"新检测速度 {grid['bpm']:.2f} BPM，网格相位 {grid['offsetSeconds']:.3f} 秒；拍号仍暂按4/4，强拍不确定时不要据此断言真实节拍。"])
    warnings.append("原始工程是整理前的基础模型结果；独立钢琴模型新增/不一致音符不在该原始工程，完整候选数组另存于模型分歧证据。")
    if grid["downbeatCoherence"] < .7:
        warnings.append("强拍在分析区间内有半小节歧义，当前选占优相位；请用节拍器核对小节第一拍。")
    if evidence.get("errors"):
        warnings.extend(str(v) for v in evidence["errors"].values())
    project["source"]["warnings"] = list(dict.fromkeys(warnings))
    project["source"]["engine"] += " + Phase2 BeatThis/FCPE/role-specific score proposal"
    after = note_quality(project["parts"])
    quality = {"stage": "proposal_requires_review", "groundTruthAvailable": False, "beatResidualMedianSeconds": grid["beatResidualMedianSeconds"], "downbeatCoherence": grid["downbeatCoherence"], **after}
    decoder_requested = request.get("decoder", "standard")
    decoder_used = detailed["parts"].get("vocals", {}).get("decoderUsed", "not_applicable" if decoder_requested == "rosvot" else decoder_requested)
    quality["decoderRequested"] = decoder_requested
    quality["decoderProfile"] = "acoustic" if decoder_used == "acoustic_fallback" else decoder_used
    quality["decoderVersion"] = "rosvot-rwbd-joint-score-1" if decoder_used == "rosvot" else DECODER_VERSIONS.get(quality["decoderProfile"], "not_applicable")
    if decoder_used == "rosvot":
        quality["vocalRhythmVersion"] = detailed["parts"]["vocals"]["scoreRhythm"]["version"]
        quality["vocalRhythmMaxOnsetShiftSeconds"] = detailed["parts"]["vocals"]["scoreRhythm"].get("maximumOnsetShiftSeconds", 0)
        project["source"]["warnings"].append("主唱为词音边界模型与节奏整理结果。FCPE/CREPE曲线及独立检查仍是原声的另外两条模型证据，不是在验证ROSVOT音符正确。")
    if decoder_used == "acoustic_fallback":
        project["source"]["warnings"].append("词音节奏模型本次未成功，已回退声学分段；主唱节奏仍需校正。")
    quality["harmony.engine"] = "Chordino audio accompaniment" if harmony_result else "symbolic accompaniment fallback"
    if harmony_result:
        quality["harmony.preserveGaps"] = True
        quality["harmony.noChordSeconds"] = harmony_result["scoreGridEditorial"]["noChordSeconds"]
        quality["harmony.boundaryQuantumBeats"] = harmony_result["scoreGridEditorial"]["quantumBeats"]
    elif harmony_error:
        project["source"]["warnings"].append("音频和弦辨识未完成，保留符号法和弦候选；详见模型证据中的audioHarmonyError。")
    quality["modelEvidenceUrl"] = f"/api/projects/{project['id']}/evidence"
    piano_details = detailed["parts"].get("piano", {}).get("consensus", {})
    if piano_details:
        quality["piano.consensusEvents"] = piano_details.get("agreedEvents", 0)
        quality["piano.retainedReviewCandidates"] = piano_details.get("reviewCandidateCount", 0)
    voice_details = detailed["parts"].get("vocals", {})
    if voice_details:
        quality["vocals.abstained"] = bool(voice_details.get("abstained"))
        quality["vocals.verificationReason"] = voice_details.get("independentVerification", {}).get("reason", "not_available")
    if identity:
        quality["vocals.leadIdentityAvailable"] = bool(identity.get("available"))
        quality["vocals.leadIdentityAccepted"] = bool(identity.get("accepted"))
        quality["vocals.leadIdentityPartial"] = bool(identity.get("usablePartial") and not identity.get("accepted"))
        if identity.get("available"):
            quality["leadAudioUrl"] = f"/api/audio/{project['id']}/stem-lead.wav"
            quality["backingAudioUrl"] = f"/api/audio/{project['id']}/stem-backing.wav"
            checked = identity.get("leadVerification", {}).get("intervals", [])
            quality["vocals.independentCheckSeconds"] = sum(float(row.get("durationSeconds", 0)) for row in checked)
            quality["vocals.independentCoverageFraction"] = round(min(1., quality["vocals.independentCheckSeconds"] / max(duration, .001)), 4)
            project["source"]["warnings"].append(f"独立音高检查仅抽样{quality['vocals.independentCheckSeconds']:g}秒（共{duration:g}秒），未抽样部分未核实；通过抽样不代表全曲主唱身份或音符正确。")
        else:
            project["source"]["warnings"].append("未安装主唱/伴唱身份分离模型；两个音高模型一致也可能共同跟到伴唱，当前只有主导音高提案。")
    project["source"]["analysis"] = {"rhythm": {key: grid[key] for key in ("bpm", "offsetSeconds", "beatTimesSeconds", "downbeatTimesSeconds", "method", "confidence")}, "transforms": transforms, "rawProjectUrl": f"/api/projects/{project['id']}/raw", "quality": quality}
    if identity and identity.get("uncertaintyIntervals"):
        project["source"]["analysis"]["uncertaintyIntervals"] = identity["uncertaintyIntervals"]
        project["source"]["warnings"].append("主唱提案保留整条KARA2主唱线，但标记的时间段存在独立音高模型分歧；这些段落仍待定，没有静默切高八度或删音。")
    verification_mode = request.get("verification", "full" if request.get("mode") == "separate" else "sampled")
    quality["verificationMode"] = verification_mode
    quality["verificationStatus"] = "sampled" if verification_mode == "sampled" else "not_applicable"
    if verification_mode == "full":
        lead_path = directory / "stem-lead.wav"
        contour_path = directory / "lead-identity/lead-models/vocals-fcpe.npz"
        if lead_path.is_file() and contour_path.is_file():
            from .voice_verification import apply_dense_voice_evidence, run_dense_voice_verification
            try:
                audit = run_dense_voice_verification(directory, lead_path, contour_path, status)
                apply_dense_voice_evidence(project, detailed, audit)
            except Cancelled:
                raise
            except Exception as error:
                logging.exception("Full lead verification failed; score proposal retained as unverified")
                quality["verificationStatus"] = "failed"
                quality["verificationError"] = str(error)
                quality["vocals.leadIdentityAccepted"] = False
                project["source"]["warnings"].append("请求的完整主唱核对未完成，当前仅保留谱面提案与已有抽样证据，不视为已完整核对。错误详情见模型证据。")
                detailed["denseVoiceAudit"] = {"status": "failed", "error": str(error), "fullCoverageVerified": False}
        else:
            quality["verificationStatus"] = "not_applicable"
            quality["verificationError"] = "No separated lead/FCPE contour available"
            project["source"]["warnings"].append("本模式/结果没有可核对的独立主唱音频与连续音高，完整主唱核对不适用；未核对不代表无错音。")
    detailed["afterMetrics"] = after
    detailed["transforms"] = transforms
    atomic_json(directory / "quality-evidence.json", detailed)
    return project

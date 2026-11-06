from __future__ import annotations

import json
import logging
import math
import subprocess
import time
from pathlib import Path

import numpy as np

from . import config
from .storage import Cancelled, JobStatus, atomic_json, utc_now


PART_INFO = {
    "vocals": ("人声候选", "Vox", "vocal source candidate", "lead", "treble", 53, "#bf7054"),
    "piano": ("钢琴候选", "Pno", "piano source candidate", "instrument", "treble", 0, "#607d8b"),
    "guitar": ("吉他候选", "Gtr", "guitar source candidate", "instrument", "treble", 24, "#a28850"),
    "bass": ("贝斯候选", "Bass", "bass source candidate", "bass", "bass", 33, "#5e8170"),
    "drums": ("打击乐候选", "Perc", "drum source candidate", "percussion", "percussion", 0, "#81708a"),
    "other": ("其他 / 未分辨乐器", "Other", "unresolved accompaniment", "instrument", "treble", 0, "#838883"),
    "mix": ("混合音轨", "Mix", "unseparated polyphonic audio", "instrument", "treble", 0, "#5e8170"),
}


def _run(command: list[str], timeout: int) -> str:
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=True)
        return result.stdout
    except subprocess.TimeoutExpired as error:
        raise ValueError("音频解码超时，请换用较短的 WAV / MP3 文件。") from error
    except subprocess.CalledProcessError as error:
        logging.warning("Audio decode error: %s", error.stderr[-3000:])
        raise ValueError("无法解码此音频。文件可能损坏或格式不受支持。") from error


def decode_audio(directory: Path, request: dict) -> tuple[float, float]:
    ffprobe = config.binary("ffprobe")
    ffmpeg = config.binary("ffmpeg")
    if not ffprobe or not ffmpeg:
        raise ValueError("找不到 FFmpeg，请运行 scripts/setup-audio.sh。")
    source = directory / request["input"]
    with source.open("rb") as handle:
        prefix = handle.read(256).lstrip()
    if prefix.startswith((b"#EXTM3U", b"ffconcat", b"[playlist]", b"<?xml", b"<MPD")):
        raise ValueError("不支持播放列表、网络地址或外部引用文件，请上传音频本身。")
    info = json.loads(_run([ffprobe, "-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries", "format=duration:stream=codec_type,duration", "-of", "json", str(source)], 20))
    if not any(s.get("codec_type") == "audio" for s in info.get("streams", [])):
        raise ValueError("文件中没有可读取的音频轨。")
    raw_duration = info.get("format", {}).get("duration")
    if raw_duration is None:
        raw_duration = next((s.get("duration") for s in info.get("streams", []) if s.get("duration")), None)
    try:
        duration = float(raw_duration)
    except (TypeError, ValueError) as error:
        raise ValueError("无法确定音频时长，请先转为 WAV 或 MP3。") from error
    if not math.isfinite(duration) or duration < 0.2:
        raise ValueError("音频不足 0.2 秒，无法转写。")
    if duration > config.MAX_DURATION_SECONDS:
        raise ValueError("当前本地 MVP 只接受 10 分钟以内的音频，请先截取需要的片段。")
    _run([ffmpeg, "-v", "error", "-nostdin", "-y", "-protocol_whitelist", "file,pipe", "-i", str(source), "-vn", "-map", "0:a:0", "-ac", "2", "-ar", "44100", "-t", str(config.MAX_DURATION_SECONDS + 0.1), "-c:a", "pcm_s16le", str(directory / "original.wav")], 120)
    analyzed = min(duration, float(request["max_seconds"]))
    _run([ffmpeg, "-v", "error", "-nostdin", "-y", "-i", str(directory / "original.wav"), "-t", str(analyzed), "-c:a", "pcm_s16le", str(directory / "analysis.wav")], 60)
    import soundfile as sf
    audio, sr = sf.read(directory / "analysis.wav", dtype="float32")
    if not np.isfinite(audio).all():
        raise ValueError("音频数据包含无效采样值。")
    if float(np.max(np.abs(audio))) < 0.0001 or float(np.sqrt(np.mean(audio ** 2))) < 0.000025:
        raise ValueError("音频为静音或电平过低，无法识别音符。")
    return duration, len(audio) / sr


def detect_tempo_and_key(y: np.ndarray, sr: int, requested_tempo: float | None) -> tuple[float, str, list[str]]:
    import librosa
    warnings = ["拍号暂按 4/4，速度按恒定 BPM；自由速度、弱起与变拍号需人工校对。", "音符吸附到十六分音符网格，滑音、颤音、连音与原始微时值不会完整保留。"]
    if requested_tempo is not None:
        tempo = float(requested_tempo)
    else:
        onset = librosa.onset.onset_strength(y=y, sr=sr)
        estimated, beats = librosa.beat.beat_track(onset_envelope=onset, sr=sr, start_bpm=110, trim=False)
        tempo = float(np.ravel(estimated)[0])
        if not math.isfinite(tempo) or tempo < 30 or len(beats) < 3:
            tempo = 120.0
            warnings.append("节拍证据不足，暂用 120 BPM。请在转写前手动指定正确速度。")
        else:
            while tempo < 65:
                tempo *= 2
            while tempo > 180:
                tempo /= 2
            tempo = round(tempo, 1)
            warnings.append(f"自动估计速度 {tempo:g} BPM，可能存在半速 / 倍速歧义。")
    harmonic = librosa.effects.harmonic(y)
    chroma = librosa.feature.chroma_stft(y=harmonic, sr=sr)
    vector = np.mean(chroma, axis=1)
    major = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
    minor = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
    names = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
    scores = [(float(np.corrcoef(vector, np.roll(profile, root))[0, 1]), names[root] + suffix) for profile, suffix in ((major, ""), (minor, "m")) for root in range(12)]
    key = max(scores, key=lambda item: item[0] if math.isfinite(item[0]) else -1)[1]
    warnings.append(f"调性 {key} 为整段色度模板估计，不代表转调检测结果。")
    return tempo, key, warnings


def quantize_notes(events: list, tempo: float, duration_seconds: float, part_id: str) -> list[dict]:
    quantum = 0.25
    last_beat = duration_seconds * tempo / 60
    by_onset: dict[tuple[float, int], dict] = {}
    for start_seconds, end_seconds, midi, amplitude, *_ in events:
        if not all(math.isfinite(float(v)) for v in (start_seconds, end_seconds, midi, amplitude)):
            continue
        if end_seconds - start_seconds < 0.075 or start_seconds >= duration_seconds or not 21 <= midi <= 108:
            continue
        start = max(0.0, round(float(start_seconds) * tempo / 60 / quantum) * quantum)
        end = max(start + quantum, round(min(float(end_seconds), duration_seconds) * tempo / 60 / quantum) * quantum)
        if start >= math.ceil(last_beat / 4) * 4:
            continue
        amplitude = max(0.01, min(1.0, float(amplitude)))
        note = {"id": "", "midi": int(midi), "start": start, "duration": round(end - start, 4), "velocity": round(max(0.18, min(1, amplitude ** 0.55)), 3), "confidence": round(amplitude, 4), "origin": "transcribed"}
        key = (start, int(midi))
        if key not in by_onset or note["confidence"] > by_onset[key]["confidence"]:
            by_onset[key] = note
    notes = sorted(by_onset.values(), key=lambda n: (n["start"], n["midi"]))
    by_pitch: dict[int, dict] = {}
    for index, note in enumerate(notes):
        note["id"] = f"{part_id}-n{index + 1}"
        previous = by_pitch.get(note["midi"])
        if previous and previous["start"] + previous["duration"] > note["start"]:
            previous["duration"] = max(quantum, note["start"] - previous["start"])
        by_pitch[note["midi"]] = note
    return notes


def consolidate_weak_tails(events: list, y: np.ndarray, sr: int) -> list:
    """Join a short fading continuation only when there is no acoustic reattack."""
    merged = []
    by_pitch = {}
    for item in sorted(events, key=lambda event: (event[0], event[2])):
        event = list(item)
        start, end, pitch, amplitude = event[:4]
        previous = by_pitch.get(pitch)
        if previous and -0.01 <= start - previous[1] <= 0.025 and end - start <= 0.145 and previous[1] - previous[0] >= 0.24 and amplitude < previous[3] * 0.9:
            position = int(start * sr)
            window = max(1, int(0.025 * sr))
            before = y[max(0, position - window):position]
            after = y[position:min(len(y), position + window)]
            if len(before) and len(after) and float(np.mean(after ** 2)) <= float(np.mean(before ** 2)) * 1.12:
                previous[1] = max(previous[1], end)
                continue
        merged.append(event)
        by_pitch[pitch] = event
    return merged


def transcribe(path: Path, model, tempo: float, duration_seconds: float, part_id: str) -> tuple[list[dict], list]:
    import soundfile as sf
    from basic_pitch.inference import predict
    minimum_frequency = 27.5 if part_id in {"bass", "mix"} else 40.0
    maximum_frequency = 500.0 if part_id == "bass" else 2400.0
    _, _, events = predict(path, model_or_model_path=model, onset_threshold=0.5, frame_threshold=0.3, minimum_note_length=100, minimum_frequency=minimum_frequency, maximum_frequency=maximum_frequency, midi_tempo=tempo, multiple_pitch_bends=False)
    raw = [[float(start), float(end), int(midi), float(amplitude)] for start, end, midi, amplitude, *_ in events]
    audio, sr = sf.read(path, dtype="float32", always_2d=True)
    mono = audio.mean(axis=1)
    minimum_rms = max(0.00003, float(np.sqrt(np.mean(mono ** 2))) * 0.015)
    audible = []
    for event in events:
        segment = mono[max(0, int(event[0] * sr)):min(len(mono), int(event[1] * sr))]
        if len(segment) and float(np.sqrt(np.mean(segment ** 2))) >= minimum_rms:
            audible.append(event)
    if part_id == "bass":
        # Bass stems often carry octave harmonics. Keep the lower fundamental when it has stronger evidence.
        audible = [event for event in audible if not any(other[2] == event[2] - 12 and abs(other[0] - event[0]) < 0.06 and other[3] > event[3] * 1.15 and min(other[1], event[1]) - max(other[0], event[0]) > 0.07 for other in audible)]
    consolidated = consolidate_weak_tails(audible, mono, sr)
    return quantize_notes(consolidated, tempo, duration_seconds, part_id), raw


def percussion_notes(y: np.ndarray, sr: int, tempo: float) -> list[dict]:
    import librosa
    from scipy.signal import butter, sosfilt
    if y.ndim > 1:
        y = y.mean(axis=1)
    hop = 256
    onset = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    positions = librosa.onset.onset_detect(onset_envelope=onset, sr=sr, hop_length=hop, units="samples", backtrack=False)
    bands = []
    for low, high in ((35, 180), (180, 3500), (4500, min(16000, sr // 2 - 1))):
        bands.append(sosfilt(butter(3, (low, high), fs=sr, btype="bandpass", output="sos"), y))
    notes = {}
    peak = max(float(np.max(np.abs(y))), 1e-8)
    for position in positions:
        end = min(len(y), position + int(0.06 * sr))
        if end <= position:
            continue
        energy = np.array([float(np.mean(b[position:end] ** 2)) for b in bands])
        ratio = energy / max(float(energy.sum()), 1e-12)
        band = 0 if ratio[0] >= 0.35 else (1 if ratio[1] >= 0.12 else 2)
        pitch, lyric = ((36, "dum"), (38, "ka"), (42, "ts"))[band]
        start = round(position / sr * tempo / 60 * 4) / 4
        strength = float(np.max(np.abs(y[position:end]))) / peak
        key = (start, pitch)
        if key in notes:
            continue
        notes[key] = {"id": f"drums-n{len(notes) + 1}", "midi": pitch, "start": start, "duration": 0.25, "velocity": round(max(0.18, min(1.0, strength)), 3), "confidence": round(float(ratio[band]), 3), "origin": "transcribed", "lyric": lyric}
    return sorted(notes.values(), key=lambda n: n["start"])


def separate_sources(path: Path, directory: Path, status: JobStatus) -> dict[str, Path]:
    import soundfile as sf
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    checkpoint = config.MODELS_DIR / "torch" / "checkpoints" / config.DEMUCS_FILE
    if not checkpoint.is_file():
        raise ValueError("分轨模型不存在。请运行 scripts/setup-audio.sh --models；分析时不会自动联网。")
    torch.hub.set_dir(str(config.MODELS_DIR / "torch"))
    torch.set_num_threads(4)
    torch.manual_seed(0)
    model = get_model(config.DEMUCS_NAME)
    model.eval()
    audio, sr = sf.read(path, dtype="float32", always_2d=True)
    tensor = torch.from_numpy(audio.T.copy())
    reference = tensor.mean(0)
    mean, std = reference.mean(), reference.std().clamp_min(1e-8)
    normalized = (tensor - mean) / std
    status.update(25, "separating", "正在本机分离人声、鼓、贝斯、吉他、钢琴与其余伴奏。复杂混音会更慢。")
    # CPU is portable and avoids unsupported complex STFT operators on MPS.
    with torch.inference_mode():
        sources = apply_model(model, normalized[None], device="cpu", shifts=0, split=True, overlap=0.25, progress=False, num_workers=0, segment=6)[0]
    sources = sources * std + mean
    paths = {}
    for name, waveform in zip(model.sources, sources):
        status.check_cancelled()
        target = directory / f"stem-{name}.wav"
        sf.write(target, waveform.cpu().numpy().T, sr, subtype="PCM_24")
        paths[name] = target
    return paths


def infer_chords(parts: list[dict], total_beats: float) -> list[dict]:
    names = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
    chords = []
    pitched = [n for p in parts if p["role"] != "percussion" for n in p["notes"] if n["midi"] is not None]
    qualities = [("", (0, 4, 7)), ("m", (0, 3, 7)), ("7", (0, 4, 7, 10)), ("m7", (0, 3, 7, 10)), ("dim", (0, 3, 6))]
    for start in np.arange(0, total_beats, 4):
        histogram = np.zeros(12)
        for note in pitched:
            overlap = max(0, min(float(start) + 4, note["start"] + note["duration"]) - max(float(start), note["start"]))
            histogram[note["midi"] % 12] += overlap * note["velocity"]
        if histogram.sum() < 0.05 or np.count_nonzero(histogram > 0.05) < 2:
            continue
        candidates = []
        for root in range(12):
            for suffix, intervals in qualities:
                pcs = [(root + i) % 12 for i in intervals]
                included = float(histogram[pcs].sum())
                outsider = float(histogram.sum() - included)
                covered = np.count_nonzero(histogram[pcs] > 0.05)
                score = included - 0.65 * outsider + 0.12 * float(histogram[root]) - 0.24 * (len(pcs) - covered)
                candidates.append((score, root, suffix, intervals, included / float(histogram.sum())))
        _, root, suffix, intervals, fit = max(candidates, key=lambda item: item[0])
        chords.append({"start": float(start), "duration": 4, "symbol": names[root] + suffix, "pitches": [48 + root + i for i in intervals], "confidence": round(fit, 3)})
    return chords


def analyze_audio(directory: Path, request: dict, status: JobStatus) -> dict:
    import librosa
    import soundfile as sf

    started = time.monotonic()
    status.update(3, "decoding", "正在校验并解码本机音频。")
    original_duration, analyzed_duration = decode_audio(directory, request)
    status.check_cancelled()
    audio, sr = sf.read(directory / "analysis.wav", dtype="float32", always_2d=True)
    mono = audio.mean(axis=1)
    y = librosa.resample(mono, orig_sr=sr, target_sr=22050)
    status.update(10, "rhythm", "正在估计速度与调性。")
    tempo, key, warnings = detect_tempo_and_key(y, 22050, request["tempo"])
    if original_duration > analyzed_duration + 0.1:
        warnings.insert(0, f"原音频 {original_duration:.1f} 秒，本次只分析前 {analyzed_duration:.1f} 秒；完整原音频仍可播放。")
    warnings.append("模型激活值只用于排序，不是准确率。自动结果必须与原音频逐段核对。")
    if request["mode"] != "multi":
        warnings.append("同音高短尾音若能量衰减且无再次起音，会并入前音；重复音仍需听辨核对。")
    candidates = []
    status.update(17, "instruments", "正在用本机音频分类器检查乐器类别候选。")
    if config.engine_health()["instrumentClassifier"]["ready"]:
        try:
            from .instruments import classify_instruments
            candidates = classify_instruments(y, 22050)
            warnings.append("乐器候选来自 AudioSet 分类器抽样，可能漏检或误报；候选并不意味着已分离出该乐器声部。")
        except Exception:
            logging.exception("Optional instrument classifier failed")
            warnings.append("可选乐器分类器本次运行失败；转写继续，不提供虚构的乐器候选。")
    else:
        warnings.append("未安装可选乐器分类器，不进行乐器类别推断。")
    status.check_cancelled()
    if request["mode"] == "separate":
        paths = separate_sources(directory / "analysis.wav", directory, status)
        warnings.append("Demucs 输出六类来源候选，钢琴尤其可能串音；木管、铜管与弦乐仍混在 other，尚不能还原逐件管弦乐总谱。")
        warnings.append("鼓谱由频带能量与起音启发式生成，不是精确的架子鼓 / 管弦打击乐分类。")
        warnings.append("低音轨会抑制较弱的同步高八度谐波；刻意的八度重奏仍需人工核对。")
    elif request["mode"] == "multi":
        paths = {}
        warnings.append("YourMT3+ 是实验性联合转写，直接预测乐器族群，不生成可单独听的分离音频。")
        warnings.append("弦乐族群包含小提琴、中提琴、大提琴等，管乐亦为族群；不能将族群名当作每一件乐器的精确身份。")
        warnings.append("多乐器模型未提供校准置信度或力度，回放力度设为统一值；低音乐器可能出现高低八度错误。")
        warnings.append("YourMT3+ 作为单独可选研究组件安装，发布或商用前需核对源码与模型许可。")
    else:
        paths = {"mix": directory / "analysis.wav"}
        warnings.append("快速转写没有分离声部。混合音轨保留可检测的复音，不能将谱中的音直接归属于某件乐器。")
    if not candidates and config.engine_health()["instrumentClassifier"]["ready"]:
        warnings.append("分类器没有给出超过显示阈值的明确乐器类别；这不代表原音频没有乐器。")
    model = None
    if paths:
        status.update(48 if request["mode"] == "separate" else 35, "transcribing", "正在加载 Basic Pitch ONNX，识别音高与起止时间。")
        from basic_pitch.inference import Model
        model = Model(config.basic_pitch_path())
    parts = []
    raw_events = {}
    if request["mode"] == "multi":
        from .multi import transcribe_multi
        parts, multi_evidence = transcribe_multi(directory, request, status, tempo, analyzed_duration)
        raw_events["multi"] = multi_evidence
        if multi_evidence.get("decodeErrors"):
            warnings.append("多乐器模型部分跨片段连音 / 起音事件不一致，已保留可解码事件；跨段长音需重点核对。")
    ordered = [name for name in ("vocals", "piano", "guitar", "bass", "other", "drums", "mix") if name in paths]
    mix_rms = max(float(np.sqrt(np.mean(audio ** 2))), 1e-8)
    for index, name in enumerate(ordered):
        status.update(50 + int(42 * index / len(ordered)), "transcribing", f"正在转写 {PART_INFO[name][0]}（{index + 1}/{len(ordered)}）。")
        stem, stem_sr = sf.read(paths[name], dtype="float32", always_2d=True)
        relative_rms = float(np.sqrt(np.mean(stem ** 2))) / mix_rms
        if name != "mix" and relative_rms < 0.014:
            warnings.append(f"{PART_INFO[name][0]} 的分离信号很弱，未自动创建空谱；仍可检查分轨音频。")
            continue
        if name == "drums":
            notes = percussion_notes(stem, stem_sr, tempo)
        else:
            notes, raw_events[name] = transcribe(paths[name], model, tempo, analyzed_duration, name)
        if not notes:
            warnings.append(f"{PART_INFO[name][0]} 未检出可靠起音。")
            continue
        label, short, instrument, role, clef, program, color = PART_INFO[name]
        parts.append({"id": name, "name": label, "shortName": short, "instrument": instrument, "role": role, "clef": clef, "program": program, "color": color, "notes": notes, "muted": False, "solo": False, "volume": 0.8, "pan": 0, "stemUrl": f"/api/audio/{request['id']}/{paths[name].name}"})
    if not parts:
        raise ValueError("这段音频未检出可用音符。可尝试更清晰的片段、快速转写或先导入 MIDI；没有使用演示音符替代。")
    status.update(95, "score", "正在量化节拍、生成总谱与待校对和弦。")
    end = max(n["start"] + n["duration"] for p in parts for n in p["notes"])
    measures = max(1, math.ceil(max(end, analyzed_duration * tempo / 60) / 4))
    chords = infer_chords(parts, measures * 4)
    if chords:
        warnings.append("和弦按每小节已转写音符的音级匹配生成，不是人工确认的原曲和声。")
    now = utc_now()
    engine = "Basic Pitch 0.4.0 (ONNX)"
    if request["mode"] == "separate":
        engine = "Demucs 4.0.1 / htdemucs_6s + " + engine
    elif request["mode"] == "multi":
        engine = "YourMT3+ YPTF.MoE+Multi noPS (local CPU, experimental)"
    project = {"version": 1, "id": request["id"], "title": Path(request["filename"]).stem, "composer": "音频转写 · 待校对", "tempo": tempo, "timeSignature": [4, 4], "key": key, "measures": measures, "parts": parts, "chords": chords, "source": {"kind": "audio", "filename": request["filename"], "engine": engine, "warnings": warnings, "detectedInstruments": candidates}, "originalAudio": {"name": request["filename"], "url": f"/api/audio/{request['id']}/original.wav", "duration": original_duration, "offsetSeconds": 0, "tempo": tempo}, "createdAt": now, "updatedAt": now}
    import copy
    raw_project = copy.deepcopy(project)
    raw_project["source"]["warnings"].append("这是整理前的基础模型工程；若运行了独立钢琴整理模型，其新增/分歧候选应查看单独的模型分歧证据，不在本原始工程内。")
    atomic_json(directory / "raw-project.json", raw_project)
    if request.get("quality", "auto") != "raw":
        from .audio_quality import improve_project, quality_engine_ready
        if quality_engine_ready():
            try:
                project = improve_project(directory, project, request, paths, raw_events, status)
            except Cancelled:
                raise
            except Exception:
                logging.exception("Role-specific score proposal failed; preserving baseline")
                project["source"]["warnings"].append("本次谱面整理模型未完成，当前保留原始模型结果；没有替换为示例或静默删音。")
                project["source"]["analysis"] = {"transforms": [], "rawProjectUrl": f"/api/projects/{project['id']}/raw", "quality": {"stage": "quality_failed_raw_preserved", "groundTruthAvailable": False}}
    atomic_json(directory / "project.json", project)
    atomic_json(directory / "analysis-evidence.json", {"engine": engine, "runtimeSeconds": round(time.monotonic() - started, 3), "mode": request["mode"], "originalDurationSeconds": original_duration, "analyzedDurationSeconds": analyzed_duration, "tempoOverride": request["tempo"], "tempo": tempo, "key": key, "noteCounts": {p["id"]: len(p["notes"]) for p in parts}, "rawNoteEventsSeconds": raw_events, "modelVersions": config.engine_health(), "warnings": warnings})
    return project

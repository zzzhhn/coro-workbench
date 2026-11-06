from __future__ import annotations

import subprocess
import time
from pathlib import Path

from . import config
from .storage import JobStatus, read_json


def family_for_program(program: int, is_drum: bool = False) -> tuple[str, str, str, str, int]:
    if is_drum:
        return "drums", "打击乐族群", "percussion", "percussion", 0
    if program in (100, 101):
        return ("vocal-lead" if program == 100 else "vocal-choir", "主唱候选" if program == 100 else "合唱候选", "lead" if program == 100 else "harmony", "treble", 53)
    families = [(0, 7, "piano", "键盘 / 钢琴族群", "instrument", "treble", 0), (8, 15, "mallet", "有音高打击乐", "instrument", "treble", 11), (16, 23, "organ", "管风琴族群", "instrument", "treble", 19), (24, 31, "guitar", "吉他族群", "instrument", "treble", 24), (32, 39, "bass", "低音族群", "bass", "bass", 33), (40, 55, "strings", "弦乐族群", "instrument", "treble", 48), (56, 63, "brass", "铜管族群", "instrument", "treble", 60), (64, 71, "reeds", "簧管族群", "instrument", "treble", 68), (72, 79, "pipes", "长笛 / 管乐族群", "instrument", "treble", 73), (80, 87, "synth-lead", "合成器主音", "instrument", "treble", 80), (88, 99, "synth-pad", "合成器铺底", "instrument", "treble", 89)]
    for low, high, *values in families:
        if low <= program <= high:
            return tuple(values)
    return f"program-{program}", f"乐器族群 {program}", "instrument", "treble", min(127, max(0, program))


def transcribe_multi(directory: Path, request: dict, status: JobStatus, tempo: float, duration: float) -> tuple[list[dict], dict]:
    from .pipeline import quantize_notes
    source = config.MODELS_DIR / "yourmt3"
    python = source / ".venv" / "bin" / "python"
    if not config.engine_health()["yourMT3"]["ready"]:
        raise ValueError("多乐器族群实验引擎未安装，请先运行 scripts/setup-yourmt3.sh。")
    output = directory / "multi-events.json"
    progress = directory / "multi-progress.json"
    status.update(35, "multi", "正在本机加载 YourMT3+，直接联合识别乐器族群、音符和打击乐。")
    command = [str(python), str(config.ROOT / "server" / "yourmt3_runner.py"), "--source", str(source), "--audio", str(directory / "analysis.wav"), "--output", str(output), "--progress", str(progress)]
    with (directory / "multi.log").open("w", encoding="utf-8") as log:
        process = subprocess.Popen(command, cwd=config.ROOT, stdout=log, stderr=log)
        deadline = time.monotonic() + max(180, duration * 12)
        try:
            last = -1
            while process.poll() is None:
                status.check_cancelled()
                if time.monotonic() > deadline:
                    process.kill()
                    raise ValueError("多乐器族群模型超时，请缩短音频或改用分轨转写。")
                if progress.exists():
                    p = read_json(progress)
                    percent = 38 + int(52 * p["done"] / max(1, p["total"]))
                    if percent != last:
                        status.update(percent, "multi", f"多乐器族群转写 {p['done']}/{p['total']} 个片段。")
                        last = percent
                time.sleep(.2)
            if process.returncode != 0 or not output.is_file():
                raise ValueError("多乐器族群实验引擎失败。可改用分轨转写；详情保存在本机 multi.log。")
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
    result = read_json(output)
    grouped = {}
    palette = ["#5e8170", "#bf7054", "#607d8b", "#a28850", "#81708a", "#5d8b8c"]
    for event in result["events"]:
        family = family_for_program(event["program"], event["isDrum"])
        group = grouped.setdefault(family[0], {"family": family, "events": []})
        group["events"].append(event)
    parts = []
    for index, group in enumerate(grouped.values()):
        part_id, name, role, clef, program = group["family"]
        if role == "percussion":
            unique = {}
            for event in group["events"]:
                if event["start"] < 0 or event["start"] >= duration:
                    continue
                start = round(event["start"] * tempo / 60 * 4) / 4
                pitch = event["midi"]
                lyric = "dum" if pitch in (35, 36) else "ka" if pitch in (37, 38, 39, 40) else "ts"
                unique[(start, pitch)] = {"id": f"{part_id}-n{len(unique) + 1}", "midi": pitch, "start": start, "duration": .25, "velocity": .75, "origin": "transcribed", "lyric": lyric}
            notes = sorted(unique.values(), key=lambda n: (n["start"], n["midi"]))
        else:
            events = [[event["start"], event["end"], event["midi"], .75] for event in group["events"]]
            notes = quantize_notes(events, tempo, duration, part_id)
            for note in notes:
                note.pop("confidence", None)
                note["velocity"] = .75
        if not notes:
            continue
        for number, note in enumerate(notes, 1):
            note["id"] = f"{part_id}-n{number}"
        parts.append({"id": part_id, "name": name, "shortName": part_id.title()[:10], "instrument": f"YourMT3+ predicted {part_id} family", "role": role, "clef": clef, "program": program, "color": palette[index % len(palette)], "notes": notes, "muted": False, "solo": False, "volume": .8, "pan": 0})
    return parts, result

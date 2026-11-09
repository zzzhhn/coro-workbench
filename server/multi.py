from __future__ import annotations

import subprocess
import time
from pathlib import Path
import math

from . import config
from .storage import JobStatus, read_json
from .polyphonic_score import quantize_polyphonic_events
from .multi_decode import source_key
from .multi_vocal import MONOPHONIC_LEAD

# The pinned mc13_full_plus_256 task decodes MT3_FULL_PLUS instrument classes.
# Thirteen decoder channels are not thirteen output instrument identities.
INSTRUMENT_NAMES = {
    0: '原声钢琴', 2: '电钢琴', 8: '有音高打击乐', 16: '管风琴',
    24: '原声吉他', 26: '清音电吉他', 29: '失真电吉他', 32: '原声贝斯', 33: '电贝斯',
    40: '小提琴', 41: '中提琴', 42: '大提琴', 43: '低音提琴', 46: '竖琴', 47: '定音鼓',
    48: '弦乐合奏', 50: '合成弦乐', 52: '合唱音色', 55: '管弦乐重音',
    56: '小号', 57: '长号', 58: '大号', 60: '圆号', 61: '铜管合奏',
    64: '高音／中音萨克斯', 66: '次中音萨克斯', 67: '上低音萨克斯',
    68: '双簧管', 69: '英国管', 70: '巴松', 71: '单簧管', 73: '长笛类',
    80: '合成器主音', 88: '合成器铺底', 100: '人声', 101: '合唱人声',
}


def parts_from_multi_events(events: list[dict], grid: dict, duration: float, *, readable: bool = False) -> tuple[list[dict], dict]:
    """Preserve decoded classes and attacks, with bounded or editorial rhythm."""
    grouped = {}
    source_labels = {}
    monophonic_lead_counts = {}
    for event in events:
        program, drum = event.get('program'), event.get('isDrum')
        if (isinstance(program, bool) or not isinstance(program, int) or not isinstance(drum, bool)
                or not 0 <= program <= (128 if drum else 127)):
            raise ValueError('Invalid decoded instrument or drum flag')
        values = [event.get(key) for key in ('start', 'end', 'midi')]
        if any(isinstance(v, bool) or not isinstance(v, (float, int)) or not math.isfinite(v) for v in values):
            raise ValueError('Invalid decoded note fields')
        identity = source_key(event)
        if identity is not None:
            label = event.get('sourceLabel', identity)
            if not isinstance(label, str) or not 1 <= len(label) <= 100:
                raise ValueError('Invalid source label')
            if identity in source_labels and source_labels[identity] != label:
                raise ValueError('Inconsistent source label')
            source_labels[identity] = label
        velocity = event.get('velocity', .75)
        if isinstance(velocity, bool) or not isinstance(velocity, (int, float)) or not math.isfinite(velocity) or not 0 <= velocity <= 1:
            raise ValueError('Invalid decoded note velocity')
        group = (128 if drum else program, drum, identity or '')
        grouped.setdefault(group, []).append([*values[:2], values[2], velocity])
        if program == 100 and not drum and identity and event.get('rhythmEvidence') == MONOPHONIC_LEAD:
            monophonic_lead_counts[group] = monophonic_lead_counts.get(group, 0) + 1
    palette = ['#5e8170', '#bf7054', '#607d8b', '#a28850', '#81708a', '#5d8b8c']
    parts, audits = [], {}
    for index, ((program, drum, identity), rows) in enumerate(sorted(grouped.items())):
        family, _, role, clef, _ = family_for_program(program, drum)
        part_id = 'drums' if drum else f'{family}-{program}'
        if identity:
            part_id += f'-{identity}'
        name = '打击乐' if drum else INSTRUMENT_NAMES.get(program, f'乐器 {program}')
        playback_program = 0 if drum else 53 if program in (100, 101) else program
        if program in (42, 43, 47, 58, 70) and not drum:
            clef = 'bass'
        elif program == 41:
            clef = 'alto'
        monophonic_lead = readable and monophonic_lead_counts.get((program, drum, identity)) == len(rows)
        if monophonic_lead:
            from .vocal_score import quantize_vocal_rhythm
            notes, rhythm = quantize_vocal_rhythm(rows, grid, duration, part_id, preserve_confidence=False)
        elif readable:
            from .score_rhythm import infer_part_rhythm
            notes, rhythm = infer_part_rhythm(rows, grid, duration, part_id, percussion=drum, program=program)
        else:
            notes, rhythm = quantize_polyphonic_events(rows, grid, duration, part_id, percussion=drum)
        audits[part_id] = {'program': program, 'isDrum': drum, 'family': family,
                          'sourceId': identity or None, 'scoreRhythm': rhythm}
        if not notes:
            continue
        part = {'id': part_id, 'name': f'{name}候选', 'shortName': name[:8],
                'instrument': f'YourMT3+ MT3_FULL_PLUS program {program}', 'role': role,
                'roleSource': 'model', 'clef': clef, 'program': playback_program,
                'color': palette[index % len(palette)], 'notes': notes,
                'muted': False, 'solo': False, 'volume': .8, 'pan': 0}
        if identity:
            part['sourceId'] = identity
            same_class_sources = sum(p == program and d == drum for p, d, _ in grouped)
            if same_class_sources > 1:
                part['name'] += f' · {source_labels[identity]}'
        if monophonic_lead:
            part['instrument'] = 'Phoneme boundaries + same-waveform FCPE lead'
            part['staves'] = [{'number': 1, 'clef': 'treble'}]
            audits[part_id]['rhythmEvidence'] = MONOPHONIC_LEAD
        if program in (0, 2) and not drum:
            part['staves'] = [{'number': 1, 'clef': 'treble'}, {'number': 2, 'clef': 'bass'}]
            for note in notes:
                note.setdefault('staff', 1 if note['midi'] >= 60 else 2)
        parts.append(part)
    return parts, {'instrumentVocabulary': 'MT3_FULL_PLUS', 'parts': audits,
                   'inputEvents': len(events), 'outputNotes': sum(len(p['notes']) for p in parts),
                   'claimsIndividualPerformerIdentity': False, 'confidenceAvailable': False}


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
    source = config.MODELS_DIR / "yourmt3"
    python = source / ".venv" / "bin" / "python"
    if not config.engine_health()["yourMT3"]["ready"]:
        raise ValueError("多乐器族群实验引擎未安装，请先运行 scripts/setup-yourmt3.sh。")
    output = directory / "multi-events.json"
    progress = directory / "multi-progress.json"
    status.update(35, "multi", "正在本机加载 YourMT3+，联合识别多声部音符、乐器类别和打击乐。")
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
                        status.update(percent, "multi", f"多声部转写 {p['done']}/{p['total']} 个片段。")
                        last = percent
                time.sleep(.2)
            if process.returncode != 0 or not output.is_file():
                raise ValueError("多乐器族群实验引擎失败。可改用分轨转写；详情保存在本机 multi.log。")
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
    result = read_json(output)
    parts, conversion = parts_from_multi_events(result['events'], {'bpm': tempo, 'offsetSeconds': 0}, duration)
    return parts, {**result, 'scoreConversion': conversion}

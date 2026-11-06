"""Select a saved or newly separated vocal input without changing other stems."""
from __future__ import annotations

import json
from pathlib import Path
import re
import shutil
import subprocess
import time

from . import config
from .storage import JobStatus, atomic_json

CHOICES = {'current', 'original-vocals', 'enhanced-lead', 'enhanced-vocals'}


def resolve_input(root: Path, stored: dict, current: Path, choice: str) -> Path:
    from .vocal_rebuild import safe_file
    import soundfile as sf
    if choice not in CHOICES:
        raise ValueError('未知人声输入选项。')
    if choice == 'current':
        return current
    match = re.fullmatch(r'/api/audio/([a-f0-9]{32})/original\.wav', stored.get('originalAudio', {}).get('url', ''))
    if not match:
        raise ValueError('原录音没有可复用的本机分析段。')
    name = 'stem-vocals.wav' if choice == 'original-vocals' else 'analysis.wav'
    selected = safe_file(root, root / match[1] / name)
    if abs(sf.info(selected).duration - sf.info(current).duration) > .05:
        raise ValueError('原人声、原录音与当前分析段长度不一致，未自动猜测剪裁范围。')
    return selected


def contour_path(stem: Path) -> Path:
    return stem.parent / ('lead-identity/lead-models/vocals-fcpe.npz' if stem.name == 'stem-lead.wav' else 'quality-models/vocals-fcpe.npz')


def extract_selected_contour(stem: Path, status: JobStatus) -> tuple[Path, dict]:
    """Use the isolated FCPE environment; do not reuse another waveform's F0."""
    path = contour_path(stem)
    python = config.MODELS_DIR / 'audio-quality/.venv/bin/python'
    if not python.is_file():
        return path, {'available': False, 'reason': 'Optional FCPE runtime missing; native word/note timing retained'}
    output = path.parent
    output.mkdir(parents=True, exist_ok=True)
    inputs = output / 'inputs.json'
    atomic_json(inputs, {'vocals': str(stem.resolve())})
    command = [str(python), str(config.ROOT / 'server/quality_runner.py'), '--input', str(inputs), '--models', str(config.MODELS_DIR / 'audio-quality'),
               '--output', str(output), '--skip-voice-verification']
    with (output / 'inference.log').open('w') as log:
        process = subprocess.Popen(command, cwd=config.ROOT, stdout=log, stderr=subprocess.STDOUT)
        started = time.monotonic()
        try:
            while process.poll() is None:
                status.check_cancelled()
                if time.monotonic() - started > 240:
                    raise TimeoutError('新的人声输入音高提取超时。')
                time.sleep(.1)
        finally:
            from .rosvot import _stop_process
            _stop_process(process)
    if process.returncode or not path.is_file():
        raise ValueError('新的人声输入音高提取失败，原工程未改变。')
    return path, {'available': True, 'input': str(stem), 'runtimeSeconds': time.monotonic() - started,
                  'independentVerificationRun': False}


def materialize_input(directory: Path, stored: dict, current: Path, choice: str, status: JobStatus) -> tuple[Path, dict]:
    source = resolve_input(directory.parent, stored, current, choice)
    report = {'choice': choice, 'inputChanged': source != current or choice.startswith('enhanced'),
              'previousStem': str(current), 'originalSource': str(source)}
    if not choice.startswith('enhanced'):
        report['selectedStem'] = str(source)
        return source, report
    from .melband import separate_vocals
    status.update(10, 'vocal-enhance', '正在用增强模型从原分析段重新分离人声；其他乐器不重新转谱。')
    separation = separate_vocals(source, directory / 'vocal-enhancement', cancel_check=status.check_cancelled)
    vocals = directory / 'stem-vocals.wav'
    shutil.copyfile(separation['vocalsPath'], vocals)
    selected = vocals
    report['separation'] = separation
    if choice == 'enhanced-lead':
        from .lead_separation import separate_lead_backing
        status.update(15, 'vocal-enhanced-lead', '增强人声已生成，正在分离主唱与伴唱。')
        output = directory / 'lead-identity'
        report['leadSeparation'] = separate_lead_backing(vocals, config.MODELS_DIR / 'lead-separation/kara2.onnx', output, status.check_cancelled)
        for name in ('lead', 'backing'):
            shutil.copyfile(output / f'{name}.wav', directory / f'stem-{name}.wav')
        selected = directory / 'stem-lead.wav'
    status.update(18, 'vocal-input-pitch', '正在提取新输入的连续音高，不套用旧音轨的音高曲线。')
    _, report['pitchExtraction'] = extract_selected_contour(selected, status)
    report['selectedStem'] = str(selected)
    return selected, report

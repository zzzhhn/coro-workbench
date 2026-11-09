"""Rebuild a separate score from cached events; never modify source files."""
import copy
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import uuid
from .multi import parts_from_multi_events
from .score_rhythm import infer_notation_grid, VERSION
from .audio_quality import infer_accompaniment_chords


def rebuild(directory: Path, *, exact: bool = False) -> tuple[dict, dict]:
    source_evidence = directory / 'analysis-evidence.json'
    if not exact and not (directory / 'multi-events.json').exists():
        request_path = directory / 'request.json'
        request_mode = (json.loads(request_path.read_text()).get('mode')
                        if request_path.is_file() and not request_path.is_symlink() else None)
        source_mode = (json.loads(source_evidence.read_text()).get('mode')
                       if source_evidence.is_file() and not source_evidence.is_symlink() else None)
        if request_mode == 'vocal-rebuild' or source_mode in ('separate', 'vocal-rebuild'):
            from .vocal_score_rebuild import rebuild_vocal_rhythm
            return rebuild_vocal_rhythm(directory)
    for name in ('project.json', 'multi-events.json', 'analysis-evidence.json'):
        path = directory / name
        if not path.is_file() or path.is_symlink():
            raise FileNotFoundError('本机未保留该歌曲的多声部识别缓存，请重新导入原音频。')
    project = json.loads((directory / 'project.json').read_text())
    model = json.loads((directory / 'multi-events.json').read_text())
    refined = directory / 'multi-source-events.json'
    if project.get('source', {}).get('analysis', {}).get('quality', {}).get('sourceRefinementVersion'):
        if not refined.is_file() or refined.is_symlink():
            raise FileNotFoundError('本机未保留该谱本的声源复核事件，无法无损重建。')
        model = json.loads(refined.read_text())
    evidence = json.loads((directory / 'analysis-evidence.json').read_text())
    grid = project.get('source', {}).get('analysis', {}).get('rhythm')
    if grid is None:
        grid = {'bpm': project['tempo'], 'offsetSeconds': project.get('originalAudio', {}).get('offsetSeconds', 0), 'method': 'cached_tempo'}
    result = copy.deepcopy(project)
    if not exact:
        request_path = directory / 'request.json'
        request = json.loads(request_path.read_text()) if request_path.is_file() and not request_path.is_symlink() else {}
        grid = infer_notation_grid(model['events'], grid, tempo_locked=request.get('tempo') is not None)
    result['tempo'] = result['originalAudio']['tempo'] = grid['bpm']
    result['originalAudio']['offsetSeconds'] = grid['offsetSeconds']
    pedals = (model.get('sourceRefinement') or {}).get('pianoPedals')
    result['parts'], audit = parts_from_multi_events(model['events'], grid, evidence['analyzedDurationSeconds'],
                                                     readable=not exact, pedals=pedals)
    previous_parts = {p['id']: p for p in project['parts']}
    for part in result['parts']:
        previous = previous_parts.get(part['id'], {})
        if previous.get('stemUrl'):
            part['stemUrl'] = previous['stemUrl']
    if not result['parts']:
        raise ValueError('Saved inference contains no notes within the analysis range')
    result['id'] = uuid.uuid4().hex
    result['updatedAt'] = datetime.now(timezone.utc).isoformat()
    end = max(n['start'] + n['duration'] for p in result['parts'] for n in p['notes'])
    result['measures'] = max(1, math.ceil(max(end, (evidence['analyzedDurationSeconds'] - grid['offsetSeconds']) * grid['bpm'] / 60) / (project['timeSignature'][0] * 4 / project['timeSignature'][1])))
    result['chords'] = infer_accompaniment_chords(result['parts'], result['measures'] * 4)
    analysis = result['source'].setdefault('analysis', {'transforms': []})
    analysis['rhythm'] = grid
    analysis.setdefault('quality', {}).pop('timingToleranceSeconds', None)
    analysis['quality'].update(scoreQuantizerVersion=VERSION if not exact else 'bounded-reference',
                               stage='multitrack_musical_score' if not exact else 'multitrack_bounded_score', editorialTiming=not exact)
    analysis['transforms'] = [
        '从缓存模型事件重建独立谱本，原始识别和已有工程均保留。',
        '按乐句推断常规节奏、断奏与持续声部；逐音起止调整记录另存。' if not exact else '保留原始时间附近的精细记谱。',
        '同类乐器仍可能共用一个复音谱表，演奏者身份未经核实。',
    ]
    audit.update(sourceProjectId=project['id'], rebuiltProjectId=result['id'], modelRerun=False, grid=grid)
    audit['sourceRefinementVersion'] = model.get('sourceRefinement', {}).get('version')
    return result, audit

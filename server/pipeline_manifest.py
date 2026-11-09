"""Record what actually ran for one analysis job, as data and as a diagram.

Every status update appends one line to ``trace.jsonl``. When a job finishes,
``pipeline-manifest.json`` captures the executed stages and their durations,
the version constant of every server component, model readiness, and the
source fingerprint. Two runs can therefore be compared precisely: a
transcription difference is attributable to a named stage or component
version, not to a stale backend.

The manifest describes provenance. It does not judge musical quality.
"""
from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path

from .storage import atomic_json, read_json, utc_now

TRACE = 'trace.jsonl'
MANIFEST = 'pipeline-manifest.json'
# Set by the worker right after import, before any analysis work runs.
WORKER_IDENTITY: dict | None = None


def capture_worker_identity() -> dict:
    """Freeze this process's code identity at start; later disk edits do not count."""
    global WORKER_IDENTITY
    from . import config
    from .runtime import runtime_identity
    WORKER_IDENTITY = runtime_identity(config.ROOT)
    return WORKER_IDENTITY

# Stage name -> (label, layer). Unknown stages are kept under their own name, so
# new stages from branches appear without a code change here.
STAGES = {
    'queued': ('排队', 'runtime'),
    'decoding': ('解码', 'input'),
    'rhythm': ('速度与调性', 'recognition'),
    'instruments': ('乐器类别候选', 'recognition'),
    'separating': ('Demucs 声源分离', 'recognition'),
    'transcribing': ('Basic Pitch 逐轨转写', 'recognition'),
    'multi': ('YourMT3+ 多乐器转写', 'recognition'),
    'source-check': ('声源复核 · 钢琴/弦乐一致性', 'recognition'),
    'quality': ('谱面整理模型', 'notation'),
    'voice-verification': ('主唱音高复核', 'recognition'),
    'vocal-identity': ('主唱/伴唱分支', 'recognition'),
    'vocal-notes': ('主唱音符模型', 'recognition'),
    'harmony': ('伴奏和弦', 'recognition'),
    'game': ('GAME Medium 人声转写', 'recognition'),
    'lyrics': ('SOFA 歌词对齐', 'recognition'),
    'asr-draft': ('本地 ASR 歌词草稿', 'recognition'),
    'game-align': ('GAME 词边界对齐（证据）', 'recognition'),
    'score': ('记谱推断与总谱', 'notation'),
    'complete': ('完成', 'runtime'),
}
LAYER_ORDER = ('input', 'recognition', 'notation', 'presentation', 'layout', 'runtime')


def record(directory: Path, stage: str, progress: int, message: str) -> None:
    """Append one trace line. Tracing must never break an analysis."""
    try:
        with (directory / TRACE).open('a', encoding='utf-8') as handle:
            handle.write(json.dumps({'at': utc_now(), 'stage': stage, 'progress': progress, 'message': message},
                                    ensure_ascii=False) + '\n')
    except OSError:
        pass


def read_trace(directory: Path) -> list[dict]:
    path = directory / TRACE
    if not path.is_file():
        return []
    rows = []
    for line in path.read_text(encoding='utf-8').splitlines():
        try:
            rows.append(json.loads(line))
        except ValueError:
            continue
    return rows


def _seconds(value: str) -> float:
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def stage_timeline(trace: list[dict], finished_at: str | None = None) -> list[dict]:
    """Collapse consecutive updates of one stage into a span with a duration."""
    spans: list[dict] = []
    for row in trace:
        if spans and spans[-1]['stage'] == row['stage']:
            spans[-1]['updates'] += 1
            spans[-1]['lastMessage'] = row['message']
            continue
        label, layer = STAGES.get(row['stage'], (row['stage'], 'unclassified'))
        spans.append({'stage': row['stage'], 'label': label, 'layer': layer, 'startedAt': row['at'],
                      'firstMessage': row['message'], 'lastMessage': row['message'], 'updates': 1})
    ends = [s['startedAt'] for s in spans[1:]] + [finished_at or (trace[-1]['at'] if trace else None)]
    for span, end in zip(spans, ends):
        span['seconds'] = round(max(0.0, _seconds(end) - _seconds(span['startedAt'])), 3) if end else None
    return spans


def component_versions(root: Path) -> dict[str, str]:
    """Read ``VERSION`` constants without importing modules (no model loading)."""
    pattern = re.compile(r"^(?:[A-Z_]*VERSION)\s*=\s*['\"]([^'\"]+)['\"]", re.M)
    versions = {}
    for path in sorted((root / 'server').glob('*.py')):
        found = pattern.findall(path.read_text(encoding='utf-8'))
        if found:
            versions[path.stem] = found[0] if len(found) == 1 else found
    return versions


def mermaid(timeline: list[dict]) -> str:
    """A left-to-right diagram of the stages that actually ran, in order."""
    lines = ['flowchart LR']
    shown = [s for s in timeline if s['stage'] not in ('queued', 'complete')]
    for index, span in enumerate(shown):
        seconds = f" · {span['seconds']:.0f}s" if span.get('seconds') is not None else ''
        label = f"{span['label']}{seconds}".replace('"', "'")
        lines.append(f'  S{index}["{label}"]:::{span["layer"]}')
        if index:
            lines.append(f'  S{index - 1} --> S{index}')
    lines += ['  classDef recognition fill:#e8f1fb,stroke:#3b6ea5', '  classDef notation fill:#fdf1e3,stroke:#b5762a',
              '  classDef input fill:#eeeeee,stroke:#777', '  classDef unclassified fill:#f6e8f3,stroke:#8a4f7d']
    return '\n'.join(lines)


def build_manifest(directory: Path, request: dict, project: dict | None, runtime: dict | None = None,
                   engines: dict | None = None) -> dict:
    from . import config
    trace = read_trace(directory)
    timeline = stage_timeline(trace)
    analysis = (project or {}).get('source', {}).get('analysis', {})
    quality = analysis.get('quality', {})
    game = analysis.get('game') or {}
    return {
        'schemaVersion': 1,
        'jobId': request.get('id'),
        'createdAt': utc_now(),
        'request': {k: v for k, v in request.items() if k != 'lyrics_lrc'} | {'lyricsProvided': bool(request.get('lyrics_lrc', '').strip())},
        'runtime': runtime,
        'components': component_versions(config.ROOT),
        'engines': {name: {k: v for k, v in info.items() if k in ('ready', 'version', 'model', 'backend', 'engine', 'steps')}
                    for name, info in (engines or {}).items() if isinstance(info, dict)},
        'timeline': timeline,
        'layers': {layer: [s['stage'] for s in timeline if s['layer'] == layer] for layer in LAYER_ORDER},
        'outputs': {
            'parts': {p['id']: len(p['notes']) for p in (project or {}).get('parts', [])},
            'decoderProfile': quality.get('decoderProfile'),
            'scoreQuantizerVersion': quality.get('scoreQuantizerVersion'),
            'sourceRefinementVersion': quality.get('sourceRefinementVersion'),
            'leadNotationVersion': game.get('notationVersion'),
            'leadRawEvents': game.get('rawEvents'),
        },
        'mermaid': mermaid(timeline),
        'claimsMusicalCorrectness': False,
    }


PIPELINE_GENERATION = 'v5'


def provenance(manifest: dict) -> dict:
    """Compact identity stored inside the project itself, so an opened score can
    always tell which pipeline produced it (old projects simply lack it)."""
    runtime = manifest.get('runtime') or {}
    components = manifest.get('components') or {}
    return {'generation': PIPELINE_GENERATION, 'revision': runtime.get('revision'),
            'codeHash': (runtime.get('codeHash') or '')[:16] or None,
            'matchesBackend': runtime.get('matchesBackend'),
            'scoreRhythm': components.get('score_rhythm'), 'singingScore': components.get('singing_score'),
            'sourceRuntime': components.get('multi_source_runtime'), 'jobId': manifest.get('jobId')}


def write_manifest(directory: Path, request: dict, project: dict | None) -> dict | None:
    try:
        from . import config
        from .runtime import runtime_identity
        import os
        # The worker's own code identity is captured when its modules were imported
        # (WORKER_IDENTITY), not at the end of a possibly long analysis.
        identity = dict(WORKER_IDENTITY or runtime_identity(config.ROOT))
        backend = os.environ.get('CORO_BACKEND_CODE_HASH') or None
        identity['backendCodeHash'] = backend
        identity['matchesBackend'] = None if backend is None else backend == identity.get('codeHash')
        manifest = build_manifest(directory, request, project, identity, config.engine_health())
        atomic_json(directory / MANIFEST, manifest)
        return manifest
    except Exception:  # Provenance is best effort; never fail a finished analysis.
        import logging
        logging.exception('Pipeline manifest could not be written')
        return None


def main(argv=None) -> int:
    """Print the executed pipeline of an existing job: python -m server.pipeline_manifest data/<job>"""
    import sys
    args = argv if argv is not None else sys.argv[1:]
    if len(args) != 1:
        print(main.__doc__)
        return 2
    directory = Path(args[0])
    manifest_path = directory / MANIFEST
    if manifest_path.is_file():
        manifest = read_json(manifest_path)
    else:
        request = read_json(directory / 'request.json')
        project_path = directory / 'project.json'
        manifest = build_manifest(directory, request, read_json(project_path) if project_path.is_file() else None)
        manifest['note'] = 'Rebuilt after the fact; runtime fingerprint unknown for this job.'
    print(manifest['mermaid'])
    for span in manifest['timeline']:
        print(f"{span['layer']:13s} {span['stage']:20s} {span.get('seconds')!s:>9s}s  {span['lastMessage'][:60]}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

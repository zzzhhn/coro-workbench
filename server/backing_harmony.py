"""Backing-vocal line for the formal multi upload (recognition + notation inference).

The Demucs vocal stem is split into lead and backing with KARA2 (lead/backing
hypotheses, not singer identity). GAME Medium, 8 steps, transcribes the backing
stem; the shared singing notation builds one readable line. On Kong Er this
line follows the dominant backing voice; a second simultaneous harmony is not
recovered, and is not invented. The lead, piano and strings are untouched.

Any failure keeps the score without this part and records a warning: the
backing line is an addition and must never block or replace the lead.
"""
from __future__ import annotations

import copy
import subprocess
import sys
from pathlib import Path

from . import config
from .storage import Cancelled, atomic_json, read_json

VERSION = 'backing-dominant-line-1'
PART_ID = 'harmony-backing'


def backing_line_part(notes: list[dict], job_id: str, notation_version: str) -> dict:
    return {'id': PART_ID, 'name': '和声 · 伴唱主导线', 'shortName': '和声',
            'instrument': f'KARA2 backing + GAME Medium + {notation_version}', 'role': 'harmony',
            'roleSource': 'model', 'clef': 'treble', 'program': 53, 'color': '#81708a', 'notes': notes,
            'muted': False, 'solo': False, 'volume': .7, 'pan': 0,
            'stemUrl': f'/api/audio/{job_id}/stem-backing.wav'}


def insert_after_lead(project: dict, part: dict) -> dict:
    result = copy.deepcopy(project)
    parts = [p for p in result['parts'] if p['id'] != PART_ID]
    index = next((i + 1 for i, p in enumerate(parts) if p['role'] == 'lead'), 0)
    parts.insert(index, part)
    result['parts'] = parts
    return result


def transcribe_backing_line(directory: Path, project: dict, request: dict, status) -> dict:
    import numpy as np
    from .game import model_root, run_helper
    from .singing_evidence import acoustic_evidence
    from .singing_pipeline import build_singing_notes

    audit = {'version': VERSION, 'referenceNotesUsed': False, 'manualNoteEdits': 0,
             'claims': 'dominant backing line only; not singer identity; second harmony not recovered'}
    model = config.MODELS_DIR / 'lead-separation/kara2.onnx'
    stem = directory / 'stem-vocals.wav'
    grid = project['source'].get('analysis', {}).get('rhythm')
    if not model.is_file() or not stem.is_file() or not grid:
        audit['status'] = 'skipped'
        audit['reason'] = 'KARA2 model, vocal stem or rhythm grid missing'
        return _record(directory, project, audit)
    destination = directory / 'backing'
    destination.mkdir(exist_ok=True)
    try:
        backing = directory / 'stem-backing.wav'
        if not backing.is_file():
            # Optional ONNX runtime: a missing package must only skip this part.
            from .lead_separation import separate_lead_backing
            status.update(98, 'vocal-identity', '正在从人声中分出伴唱（KARA2），主唱不受影响。')
            separation = separate_lead_backing(stem, model, destination / 'kara2', status.check_cancelled)
            for name in ('lead', 'backing'):
                target = directory / f'stem-{name}.wav'
                if not target.exists():
                    target.hardlink_to(destination / 'kara2' / f'{name}.wav')
            audit['separation'] = {k: separation[k] for k in ('model', 'sha256', 'leadRms', 'backingRms', 'runtimeSeconds')}
        status.update(98, 'backing-game', '正在用 GAME Medium 8 步识别伴唱主导线。')
        root = model_root()
        run_helper([sys.executable, '-m', 'server.game_runner', '--model', str(root / 'medium'),
                    '--source', str(root / 'source'), '--audio', str(backing), '--output', str(destination / 'raw.json'),
                    '--steps', '8', '--max-chunk-seconds', '30'], destination / 'inference.log', status)
        inputs = destination / 'inputs.json'
        atomic_json(inputs, {'vocals': str(backing.resolve())})
        run_helper([str(config.MODELS_DIR / 'audio-quality/.venv/bin/python'), str(config.ROOT / 'server/quality_runner.py'),
                    '--input', str(inputs), '--models', str(config.MODELS_DIR / 'audio-quality'),
                    '--output', str(destination), '--skip-voice-verification'], destination / 'contour.log', status)
        raw = read_json(destination / 'raw.json')
        events = [dict(e, id=f'backing-{i}') for i, e in enumerate(raw['events'])]
        pcm = subprocess.check_output([config.binary('ffmpeg'), '-v', 'error', '-nostdin', '-i', str(backing),
                                       '-f', 'f32le', '-ac', '1', '-ar', '22050', '-'])
        signals = acoustic_evidence(np.frombuffer(pcm, dtype='<f4'), 22050, destination / 'vocals-fcpe.npz')
        status.update(99, 'score', '正在把伴唱主导线推断为可读节奏。')
        notes, details = build_singing_notes(events, [], grid, project['key'], signals)
        notes = [dict(n, id=f"backing-{n['id']}") for n in notes]
        audit.update(status='complete', rawEvents=len(events), scoreNotes=len(notes), notationVersion=details['version'],
                     inference={k: v for k, v in raw.items() if k not in ('events', 'segments')})
        atomic_json(destination / 'score-evidence.json', {'summary': audit, 'details': details})
    except Cancelled:
        raise
    except Exception as error:  # noqa: BLE001 - an optional part must not fail the upload
        audit.update(status='failed', reason=str(error)[:300])
        return _record(directory, project, audit)
    result = insert_after_lead(project, backing_line_part(notes, request['id'], details['version'])) if notes else project
    return _record(directory, result, audit)


def _record(directory: Path, project: dict, audit: dict) -> dict:
    result = copy.deepcopy(project)
    analysis = result['source'].setdefault('analysis', {})
    analysis['backingHarmony'] = audit
    analysis.setdefault('quality', {})['backingHarmonyVersion'] = VERSION
    if audit.get('status') == 'complete':
        analysis.setdefault('transforms', []).append(
            '伴唱：KARA2 从同一人声 stem 分出伴唱，GAME Medium 8 步识别伴唱主导线并用跟唱谱记谱推断；只有一条线，第二条和声未识别，不凭空补写。')
    else:
        result['source'].setdefault('warnings', []).append(f"伴唱主导线未生成（{audit.get('reason', '未知原因')}）；主唱与其他声部不受影响。")
    evidence_path = directory / 'quality-evidence.json'
    evidence = read_json(evidence_path) if evidence_path.is_file() else {}
    evidence['backingHarmony'] = audit
    atomic_json(evidence_path, evidence)
    return result

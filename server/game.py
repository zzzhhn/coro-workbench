"""Public upload integration for the frozen GAME Medium singing pipeline."""
from __future__ import annotations

import copy
import importlib.util
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time

from . import config
from .storage import atomic_json, read_json

VERSION = 'game-medium-import-1'


def model_root():
    return Path(os.environ.get('CORO_GAME_ROOT', config.MODELS_DIR / 'game'))


def runtime_health():
    root = model_root()
    required = [root/'medium'/f'{name}.onnx' for name in ('encoder','segmenter','estimator','dur2bd','bd2dur')]
    required += [root/'medium/config.json', root/'source/inference/slicer2.py']
    return {'ready': all(p.is_file() for p in required) and bool(config.package_version('onnxruntime')),
            'model': 'GAME 1.0.3 Medium ONNX', 'steps': 8, 'version': VERSION,
            'lyricsReady': (config.MODELS_DIR/'sofa-mandarin/pretrained_mandarin_singing/v1.0.0_mandarin_singing.ckpt').is_file()
                and (config.MODELS_DIR/'sofa-source/onnx_infer.py').is_file()
                and all(importlib.util.find_spec(name) for name in ('torch','numba','yaml','pypinyin'))}


def parse_lrc(text: str, duration: float) -> list[dict]:
    """Only line timing and lyrics are accepted, never reference note data."""
    if not text.strip():
        return []
    if len(text) > 20000:
        raise ValueError('歌词不能超过 20000 字符。')
    rows = []
    for line in text.splitlines():
        if re.fullmatch(r'\s*\[offset:[+-]?0+]\s*', line):
            continue
        if line.strip().startswith('[offset:'):
            raise ValueError('请先把 LRC 的 offset 合并到每句时间；本次不会忽略歌词偏移。')
        if not line.strip() or re.fullmatch(r'\s*\[(?:ar|ti|al|by):[^]]*]\s*', line):
            continue
        match = re.fullmatch(r'\s*\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)]\s*(.*?)\s*', line)
        if not match or float(match[2]) >= 60:
            raise ValueError('请提供逐句 LRC 歌词，例如 [00:18.20]你的歌词。暂不支持无时间歌词。')
        at = int(match[1])*60 + float(match[2])
        words = re.sub(r'[\s，。！？、,.!?…「」“”‘’（）()：:；;]', '', match[3])
        if words and any(not '\u4e00' <= c <= '\u9fff' for c in words):
            raise ValueError('歌词对齐目前支持中文演唱，其他语言可先不填歌词。')
        if rows and at <= rows[-1][0]:
            raise ValueError('歌词时间必须按演唱顺序递增。')
        rows.append((at, words))
    segments = []
    for i, (at, words) in enumerate(rows):
        if not words or at >= duration:
            continue
        end = min(duration, rows[i+1][0]+.15 if i+1 < len(rows) else at+12)
        if end-at > 32 or len(words) > 70:
            raise ValueError('每句歌词请控制在 32 秒、70 字以内；长间奏可加一个空的时间标签。')
        segments.append({'id':f'line-{i}', 'start':max(0.,at-.35), 'end':end, 'text':words})
    if not segments:
        raise ValueError('所选分析范围内没有可对齐的歌词。')
    return segments


def run_helper(command, output: Path, status, timeout=1200):
    with output.open('w') as log:
        process = subprocess.Popen(command, cwd=config.ROOT, stdout=log, stderr=log)
        try:
            deadline = time.monotonic()+timeout
            while process.poll() is None:
                status.check_cancelled()
                if time.monotonic() > deadline:
                    raise ValueError(f'GAME 人声处理超时；详情：{output.name}。未用旧模型代替。')
                time.sleep(.2)
            status.check_cancelled()
            if process.returncode:
                raise ValueError(f'GAME 人声处理失败；详情：{output.name}。未用旧模型代替。')
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()


def save_vocal_evidence(directory: Path, stem: Path, raw: dict, lyrics_provided: bool, status) -> dict:
    """Record GAME align and text-free syllable boundaries as raw evidence.

    Runs after the score is final and is never read back by notation, so the
    lead notes are identical with or without it. Failures are recorded only.
    """
    from .game_align import VERSION as EVIDENCE_VERSION, align_regions, chunk_windows
    destination = directory/'game'
    sofa_model = config.MODELS_DIR/'sofa-mandarin/pretrained_mandarin_singing/v1.0.0_mandarin_singing.ckpt'
    record = {'version': EVIDENCE_VERSION, 'usedByNotation': False, 'referenceNotesUsed': False}
    if not runtime_health()['lyricsReady']:
        record.update(syllableBoundary={'status': 'skipped', 'reason': 'sofa-not-installed'},
                      align={'status': 'skipped', 'reason': 'sofa-not-installed'})
        return record
    try:
        status.update(99, 'game-align', '正在保存无词音节边界证据（不改动谱面）。')
        atomic_json(destination/'boundary-windows.json', chunk_windows(raw))
        run_helper([sys.executable, '-m', 'server.lyrics_alignment', '--audio', str(stem),
            '--windows', str(destination/'boundary-windows.json'), '--model', str(sofa_model),
            '--output', str(destination/'syllable-boundary.npz')], destination/'boundary.log', status)
        record['syllableBoundary'] = {'status': 'saved', 'file': 'game/syllable-boundary.npz'}
    except (ValueError, OSError, KeyError) as error:
        record['syllableBoundary'] = {'status': 'failed', 'reason': str(error)}
    if not lyrics_provided:
        # Known word boundaries come only from user lyrics; ASR drafts stay offline.
        record['align'] = {'status': 'skipped', 'reason': 'no-lyrics'}
        return record
    try:
        status.update(99, 'game-align', '正在用已知字界运行 GAME 官方 align 模式（只存证据，不改动谱面）。')
        regions = align_regions(read_json(destination/'sofa/alignment.json'))
        atomic_json(destination/'align-words.json', regions)
        root = model_root()
        run_helper([sys.executable, '-m', 'server.game_runner', '--model', str(root/'medium'),
            '--source', str(root/'source'), '--audio', str(stem), '--output', str(destination/'align.json'),
            '--steps', '8', '--words', str(destination/'align-words.json')], destination/'align.log', status)
        aligned = read_json(destination/'align.json')
        record['align'] = {'status': 'saved', 'file': 'game/align.json', 'segments': len(aligned['segments']),
                           'notes': sum(len(s['notes']) for s in aligned['segments'])}
    except (ValueError, OSError, KeyError) as error:
        record['align'] = {'status': 'failed', 'reason': str(error)}
    return record


def replace_lead(project, notes, audit, job_id, *, raw=False):
    """Replace only the lead, preserving all instrumental and choir parts."""
    result = copy.deepcopy(project)
    old = [p for p in result['parts'] if p['role'] == 'lead']
    part = {**(old[0] if old else {}), 'id':'game-vocals', 'name':'主唱 · GAME Medium',
        'shortName':'Vox', 'instrument':'GAME Medium', 'role':'lead', 'clef':'treble',
        'program':53, 'color':'#c47758', 'notes':notes, 'muted':False, 'solo':False,
        'volume':.8, 'pan':0, 'stemUrl':f'/api/audio/{job_id}/stem-vocals.wav'}
    result['parts'] = [part] + [p for p in result['parts'] if p['role'] != 'lead']
    analysis = result['source'].setdefault('analysis', {})
    analysis['game'] = audit
    analysis.setdefault('quality', {}).update(decoderRequested='game', decoderProfile='game', decoderVersion=VERSION)
    if not raw:
        analysis['quality'].update(vocalLeadStatus='game_complete', vocalConsensusStatus='game_with_fcpe_evidence',
                                  modelEvidenceUrl=f'/api/projects/{job_id}/evidence')
    old_ids = {p['id'] for p in old}
    if 'uncertaintyIntervals' in analysis:
        # Legacy vocal disputes refer to replaced events, not GAME's new notes.
        analysis['uncertaintyIntervals'] = [r for r in analysis['uncertaintyIntervals'] if r['partId'] not in old_ids]
    analysis.setdefault('transforms', []).append('GAME 原始人声起止，未整理。' if raw else '分离人声 → GAME Medium 8 步 → 跟唱谱记谱推断；保留本次模型原始事件。')
    if not raw:
        analysis['rawProjectUrl'] = f'/api/projects/{job_id}/game-raw'
    else:
        analysis.pop('rawProjectUrl', None)
    result['source']['engine'] += ' + Demucs / GAME Medium 8 steps / ' + ('raw' if raw else 'singing-score')
    result['source'].setdefault('warnings', []).append(
        '原始 GAME 人声事件，仅按总谱单位换算起止。' if raw else
        '已按逐句歌词对齐人声；歌词边界与转音仍需试听。' if audit['lyricsProvided'] else
        '本次未提供歌词，使用 GAME 音频识别及记谱推断；没有启用依赖歌词的音节归纳。')
    result['measures'] = max(result['measures'], math.ceil(max((n['start']+n['duration'] for n in notes),default=0)/4))
    return result


def transcribe_lead(directory, project, request, status):
    import numpy as np
    import soundfile as sf
    from .pipeline import separate_sources
    from .singing_evidence import acoustic_evidence
    from .singing_pipeline import build_singing_notes

    if not runtime_health()['ready']:
        raise ValueError('GAME Medium 未就绪；没有使用旧模型代替。')
    stem = directory/'stem-vocals.wav'
    if not stem.is_file():
        stem = separate_sources(directory/'analysis.wav', directory, status)['vocals']
    destination = directory/'game'
    destination.mkdir(exist_ok=True)
    status.update(95, 'game', '正在用 GAME Medium 8 步识别人声乐句、音高和起止。')
    root = model_root()
    run_helper([sys.executable, '-m','server.game_runner', '--model',str(root/'medium'),
        '--source',str(root/'source'), '--audio',str(stem), '--output',str(destination/'raw.json'),
        '--steps','8','--max-chunk-seconds','30'], destination/'inference.log', status)
    raw = read_json(destination/'raw.json')
    events = [dict(e,id=f'game-{i}') for i,e in enumerate(raw['events'])]
    grid = project['source'].get('analysis',{}).get('rhythm')
    if not grid:
        raise ValueError('GAME 音符已保留，但节拍对齐未完成，请重试。没有把旧版量化当作新版结果。')
    origin, spb = grid['offsetSeconds'], 60/grid['bpm']
    # A preceding pickup cannot be clipped by a late inferred first downbeat.
    if events and events[0]['start'] < origin-1e-6:
        raise ValueError('首个主唱音早于总谱起点，需重新校对节拍相位；原始 GAME 结果已保留。')
    metadata = {k:v for k,v in raw.items() if k not in ('events','segments')}
    audit = {'version':VERSION, 'inference':metadata, 'lyricsProvided':bool(request.get('lyrics_lrc','').strip()),
             'manualNoteEdits':0, 'referenceNotesUsed':False, 'rawEvents':len(events)}
    native_notes = [dict(id=e['id'],midi=e['midi'],start=(e['start']-origin)/spb,
        duration=(e['end']-e['start'])/spb,velocity=.7,origin='transcribed') for e in events]
    atomic_json(directory/'game-raw-project.json', replace_lead(project,native_notes,audit,request['id'],raw=True))
    contour = next((p for p in (directory/'multi-source-models/vocals-fcpe.npz',
        directory/'quality-models/vocals-fcpe.npz') if p.is_file()), None)
    if contour is None:
        inputs = destination/'inputs.json'
        atomic_json(inputs, {'vocals':str(stem.resolve())})
        status.update(96,'game','正在独立计算人声音高轮廓，辅助判断滑音与真实转音。')
        run_helper([str(config.MODELS_DIR/'audio-quality/.venv/bin/python'),
            str(config.ROOT/'server/quality_runner.py'),'--input',str(inputs),
            '--models',str(config.MODELS_DIR/'audio-quality'),'--output',str(destination)],
            destination/'contour.log',status)
        contour = destination/'vocals-fcpe.npz'
    words, nucleus = [], None
    if audit['lyricsProvided']:
        segments = parse_lrc(request['lyrics_lrc'], raw['seconds'])
        atomic_json(destination/'segments.json',segments)
        status.update(97,'lyrics','正在按输入歌词对齐演唱字界。')
        run_helper([sys.executable,'-m','server.lyrics_alignment','--audio',str(stem),
            '--segments',str(destination/'segments.json'),'--model',
            str(config.MODELS_DIR/'sofa-mandarin/pretrained_mandarin_singing/v1.0.0_mandarin_singing.ckpt'),
            '--output',str(destination/'sofa')],destination/'lyrics.log',status)
        aligned = read_json(destination/'sofa/alignment.json')
        words = sorted([w for s in aligned['segments'] for w in s['words']],key=lambda w:w['vowelStart'])
        import yaml
        hp = yaml.safe_load((config.MODELS_DIR/'sofa-mandarin/pretrained_mandarin_singing/hparams.yaml').read_text())
        vocab = yaml.safe_load(hp['vocab_text'])
        def nucleus(word, previous, start, end):
            with np.load(destination/'sofa'/f"{word['id'].rsplit('-',1)[0]}-evidence.npz",allow_pickle=False) as stored:
                logp = stored['logp']; t = float(stored['start'])+np.arange(len(logp))*float(stored['hop'])
            mask = (t>=start)&(t<end)
            if mask.sum()<10:return None
            nasal = vocab[word['phones'][0]['phone']]
            return {'familyMean':float(np.exp(logp[mask][:,[vocab['a'],nasal]]).sum(axis=1).mean()),
                    'relativeNasal':float(np.exp(logp[mask,nasal]).mean()/max(1e-9,np.exp(logp[:,nasal]).mean()))}
    pcm = subprocess.check_output([config.binary('ffmpeg'),'-v','error','-nostdin','-i',str(stem),
        '-f','f32le','-ac','1','-ar','22050','-'])
    signals = acoustic_evidence(np.frombuffer(pcm,dtype='<f4'),22050,contour)
    status.update(98,'score','正在把 GAME 演唱事件推断为可读节奏，保留真实起音与原始对照。')
    notes, details = build_singing_notes(events,words,grid,project['key'],signals,nucleus)
    audit.update(scoreNotes=len(notes),notationVersion=details['version'])
    # Evidence only, after notation: the score above cannot depend on it.
    audit['vocalEvidence'] = save_vocal_evidence(directory, stem, raw, audit['lyricsProvided'], status)
    atomic_json(destination/'score-evidence.json', {'summary':audit,'details':details})
    evidence_path = directory/'quality-evidence.json'
    evidence = read_json(evidence_path) if evidence_path.is_file() else {}
    evidence['game'] = {'summary':audit, 'details':details}
    atomic_json(evidence_path, evidence)
    status.check_cancelled()
    return replace_lead(project,notes,audit,request['id'])

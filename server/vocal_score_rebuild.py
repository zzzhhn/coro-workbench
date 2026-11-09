"""Rebuild vocal notation from a completed separation's cached evidence."""

import math
from pathlib import Path
import re
from uuid import uuid4
from zipfile import BadZipFile

import numpy as np
import soundfile as sf

from .audio_quality import note_quality
from .lead_note_proposal import frame_acoustic_evidence
from .storage import JOB_ID, read_json, utc_now
from .vocal_rebuild import VOCAL_DECODERS, prepare_rebuild, safe_file, validate_snapshot
from .vocal_score import clean_vocal_fragments, quantize_vocal_rhythm
from .voice_verification import file_sha256


def _cached_file(directory: Path, name: str, label: str) -> Path:
    path = directory / name
    if not path.exists() and not path.is_symlink():
        raise FileNotFoundError(f'本机未保留{label}，无法从缓存整理主唱节奏。')
    return safe_file(directory, path)


def _object(value) -> dict:
    if not isinstance(value, dict):
        raise ValueError('缓存识别记录格式无效。')
    return value


def _event_rows(events, duration: float, *, learned: bool) -> list[list]:
    if not isinstance(events, list) or not events:
        raise ValueError('本机没有可整理的主唱事件。')
    rows = []
    for event in events:
        if learned:
            event = _object(event)
            start, end, pitch = (event[key] for key in ('source_start_seconds', 'source_end_seconds', 'midi_pitch'))
            if pitch is None:
                continue
            row = [start, end, pitch, .75]
        else:
            row = event
        if (not isinstance(row, list) or len(row) != 4
                or any(type(value) not in (int, float) or not math.isfinite(value) for value in row)
                or not 0 <= row[0] < row[1] <= duration + 1e-6
                or not 0 <= row[2] <= 127 or row[2] != int(row[2]) or not 0 <= row[3] <= 1):
            raise ValueError('缓存主唱事件的时间、音高或强度无效。')
        if rows and rows[-1][1] > row[0] + 1e-7:
            raise ValueError('缓存主唱事件重叠或顺序无效。')
        rows.append(row)
    if not rows:
        raise ValueError('缓存未包含带音高的主唱事件。')
    return rows


def _clean_acoustic(directory: Path, audit: dict, stem: Path, lead: bool, rows: list,
                    duration: float) -> tuple[list, dict, dict]:
    path = ('lead-identity/lead-models/' if lead else 'quality-models/') + 'vocals-fcpe.npz'
    contour = _cached_file(directory, path, '对应的连续音高缓存')
    hashes = {'leadSha256': file_sha256(stem), 'fcpeSha256': file_sha256(contour)}
    dense = _object(audit.get('denseVoiceAudit', {}))
    identity = 'separated_lead' if lead else 'separated_vocals'
    signature = dense.get('cacheSignature')
    if (dense.get('inputSource', identity) != identity or signature is not None
            and any(_object(signature).get(key) != value for key, value in hashes.items())):
        raise ValueError('缓存音轨或连续音高与独立核对记录不符。')
    if signature is None:
        manifest = ('lead-identity/' if lead else 'quality-models/') + 'inputs.json'
        input_path = _object(read_json(_cached_file(directory, manifest, '连续音高的输入记录'))).get('vocals')
        # Only verify the historical reference; never read from its stored absolute path.
        if not isinstance(input_path, str) or Path(input_path).parts[-2:] != (directory.name, stem.name):
            raise ValueError('连续音高的输入记录与当前主唱轨不符。')
    try:
        with np.load(contour, allow_pickle=False) as track:
            times, f0 = (np.asarray(track[key], dtype=float) for key in ('time', 'f0'))
    except (OSError, ValueError, EOFError, KeyError, TypeError, BadZipFile) as error:
        raise ValueError('连续音高缓存无效。') from error
    if (times.ndim != 1 or len(times) < 2 or f0.shape != times.shape
            or not np.all(np.isfinite(times)) or not np.all(np.isfinite(f0)) or np.any(f0 < 0)
            or not 0 <= times[0] <= .05 or abs(times[-1] - duration) > .06
            or np.any(np.diff(times) <= 0) or np.any(np.diff(times) > .05)):
        raise ValueError('连续音高缓存的时间范围与主唱分析段不符。')
    try:
        audio, sr = sf.read(stem, dtype='float32', always_2d=True)
    except (OSError, RuntimeError) as error:
        raise ValueError('无法读取缓存主唱音轨。') from error
    if not np.all(np.isfinite(audio)):
        raise ValueError('缓存主唱音轨包含无效样本。')
    features = frame_acoustic_evidence(times, audio.mean(axis=1), sr)
    cleaned, cleanup = clean_vocal_fragments(rows, times, f0, features)
    return cleaned, cleanup, {'contour': path, **hashes, 'matchedPriorVerificationHashes': signature is not None}


def rebuild_vocal_rhythm(directory: Path) -> tuple[dict, dict]:
    """Return a new score and audit without writing to the source directory."""
    job_id = directory.name
    status = _object(read_json(_cached_file(directory, 'status.json', '任务状态')))
    if not JOB_ID.fullmatch(job_id) or status.get('id') != job_id or status.get('status') != 'complete':
        raise ValueError('仅可整理已完成的本机分轨任务。')
    result = validate_snapshot(read_json(_cached_file(directory, 'project.json', '源谱')))
    request_path = directory / 'request.json'
    request = _object(read_json(safe_file(directory, request_path))) if request_path.exists() or request_path.is_symlink() else {}
    derived = request.get('mode') == 'vocal-rebuild'
    base_path = directory / 'analysis-evidence.json'
    base = (_object(read_json(_cached_file(directory, 'analysis-evidence.json', '分析范围记录')))
            if not derived or base_path.exists() or base_path.is_symlink() else None)
    audit = _object(read_json(_cached_file(directory, 'quality-evidence.json', '模型分歧证据')))
    if result['id'] != job_id or base is not None and base.get('mode') != ('vocal-rebuild' if derived else 'separate'):
        raise ValueError('缓存工程与原分轨任务不符。')
    if derived and (request.get('id') != job_id or request.get('action') != 'vocal-rebuild'
                    or not JOB_ID.fullmatch(str(request.get('source_job_id', '')))
                    or request['source_job_id'] != audit.get('vocalRebuildFromJob')):
        raise ValueError('派生主唱的任务记录与学习模型缓存不符。')
    audio = result['originalAudio']
    duration = base.get('analyzedDurationSeconds') if base is not None else request.get('max_seconds')
    if type(duration) not in (float, int) or not math.isfinite(duration) or not 0 < duration <= audio['duration'] + 1e-6:
        raise ValueError('缓存分轨的分析时长无效。')
    if derived and (type(request.get('max_seconds')) not in (float, int) or not math.isfinite(request['max_seconds'])
                    or abs(request['max_seconds'] - duration) > .025):
        raise ValueError('主唱重识别任务的分析时长与缓存不符。')
    original = re.fullmatch(r'/api/audio/([a-f0-9]{32})/original\.wav', audio['url'])
    if original is None or not derived and original[1] != job_id:
        raise ValueError('源谱的原音频与缓存任务不符。')
    original_audio = safe_file(directory.parent, directory.parent / original[1] / 'original.wav')

    analysis = result['source']['analysis']
    source_grid = _object(analysis['rhythm'])
    grid = _object(audit['grid'] if 'grid' in audit or not derived else source_grid)
    for key, expected in (('bpm', audio['tempo']), ('offsetSeconds', audio['offsetSeconds'])):
        if (type(grid[key]) not in (int, float) or grid[key] != expected or source_grid[key] != expected
                or not derived and key == 'bpm' and result['tempo'] != expected):
            raise ValueError('缓存节拍网格与源谱不符。')
    voice = _object(_object(audit['parts'])['vocals'])
    if voice.get('abstained') or not derived and analysis.get('quality', {}).get('vocals.abstained'):
        raise ValueError('原任务未确认单声部主唱候选，不能用缓存替换现有谱面。')
    vocals = next((part for part in result['parts'] if part['id'] == 'vocals'), None)
    if vocals is None:
        raise ValueError('缓存工程没有可整理的主唱声部。')
    lead = voice.get('leadIdentityUsed', False)
    stem_name = 'stem-lead.wav' if lead else 'stem-vocals.wav'
    if derived:
        _, _, stem, _ = prepare_rebuild(directory.parent, job_id, result)
        stem_name = stem.name
        selected = _object(audit.get('vocalInput', {})).get('selectedStem')
        if selected is not None and (not isinstance(selected, str) or Path(selected).parts[-2:] != (stem.parent.name, stem_name)):
            raise ValueError('缓存主唱事件与重识别时的人声输入不符。')
    else:
        if type(lead) is not bool or vocals.get('stemUrl') != f'/api/audio/{job_id}/{stem_name}':
            raise ValueError('主唱试听轨与缓存声源不符。')
        stem = _cached_file(directory, stem_name, '主唱试听轨')
    try:
        stem_duration = sf.info(stem).duration
        original_duration = sf.info(original_audio).duration
    except (OSError, RuntimeError) as error:
        raise ValueError('无法读取缓存主唱音轨。') from error
    if abs(stem_duration - duration) > .025 or abs(original_duration - audio['duration']) > .025:
        raise ValueError('缓存主唱音轨时长与分析段不符。')

    event_source = voice.get('eventSourceBeforeLearnedModel')
    decoder = voice.get('decoderUsed', event_source)
    learned = isinstance(decoder, str) and decoder in VOCAL_DECODERS
    if derived and (not learned or decoder != request.get('decoder', 'rosvot')
                    or decoder != analysis.get('quality', {}).get('decoderProfile')):
        raise ValueError('派生谱本缺少对应学习引擎的原始音符缓存。')
    provenance = {'decoderUsed': decoder, 'stem': stem_name, 'stemJobId': stem.parent.name}
    if learned:
        if 'alignedVocalEvents' in voice:
            provenance['events'] = 'alignedVocalEvents'
            events = voice['alignedVocalEvents']
        else:
            provenance['events'] = 'learnedVocalNotes.events'
            events = voice['learnedVocalNotes']['events']
        rows = _event_rows(events, duration, learned=True)
    else:
        check = _object(voice.get('independentVerification', {}))
        if (event_source not in ('acoustic', 'standard', 'legato')
                or decoder not in (event_source, f'{event_source}_fallback')
                or check.get('available') is not True or check.get('abstain') is not False):
            raise ValueError('缓存未提供经过独立核对的单声部主唱候选。')
        provenance['events'] = 'fcpeAlternativeEvents'
        rows = _event_rows(voice['fcpeAlternativeEvents'], duration, learned=False)
        rows, voice['fragmentCleanup'], inputs = _clean_acoustic(directory, audit, stem, lead, rows, duration)
        provenance.update(inputs)

    bpm = grid['bpm']
    quantizer_bpm = bpm * 2 if bpm < 20 else bpm / 2 if bpm > 300 else bpm
    notes, rhythm = quantize_vocal_rhythm(rows, {**grid, 'bpm': quantizer_bpm}, duration, preserve_confidence=not learned)
    if not notes:
        raise ValueError('缓存没有可整理为乐谱的主唱音符。')
    if bpm != quantizer_bpm:
        scale = bpm / quantizer_bpm
        for note in notes:
            note['start'] = round(note['start'] * scale, 6)
            note['duration'] = round(note['duration'] * scale, 6)
        rhythm['beatUnitScale'] = scale
    before_count = sum(note['midi'] is not None for note in vocals['notes'])
    vocals['notes'] = notes
    bar_beats = result['timeSignature'][0] * 4 / result['timeSignature'][1]
    result['measures'] = max(result['measures'], math.ceil(max(n['start'] + n['duration'] for n in notes) / bar_beats - 1e-9))
    if result['measures'] > 2048:
        raise ValueError('整理后的乐谱超过 2048 小节上限。')
    result['id'] = uuid4().hex
    result['updatedAt'] = utc_now()

    message = '复用已保存的主唱事件，按节拍整理时值和休止。谱面仍需对照原音频校对。'
    analysis['transforms'].append(message)
    metrics = note_quality([vocals])
    quality = analysis.setdefault('quality', {})
    quality.update(metrics, vocalRhythmVersion=rhythm['version'],
                   vocalRhythmMaxOnsetShiftSeconds=rhythm['maximumOnsetShiftSeconds'],
                   vocalRhythmMaxOffsetShiftSeconds=rhythm['maximumOffsetShiftSeconds'],
                   modelEvidenceUrl=f"/api/projects/{result['id']}/evidence", nativeEventsJobId=job_id,
                   verificationRerun=False, vocalNotesVerified=False)
    if learned:
        quality['decoderVersion'] = VOCAL_DECODERS[decoder]
    voice.update(scoreRhythm=rhythm, outputNotes=len(notes))
    _object(audit.setdefault('afterMetrics', {})).update(metrics)
    transforms = audit.setdefault('transforms', [])
    if not isinstance(transforms, list):
        raise ValueError('缓存节奏整理记录格式无效。')
    transforms.append(message)
    audit.update(sourceProjectId=job_id, rebuiltProjectId=result['id'], analyzedDurationSeconds=duration, grid=grid,
                 beforeVocalNotes=before_count, afterVocalNotes=len(notes), cachedVocalSource=provenance,
                 modelRerun=False, verificationRerun=False, validatesCurrentNotes=False)
    return result, audit

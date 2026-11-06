"""Isolated native ROSVOT driver. Heavy ML imports run only in its own process.

All timestamps are source-audio seconds. Native rest events are retained. Chunk
ownership only clips context; seam continuation flags let score logic distinguish
an artificial chunk cut from a model-predicted note boundary.
"""
from __future__ import annotations
import json
import hashlib
import math
import os
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / 'models/rosvot'
_INTEGRITY_CACHE: dict = {}


def _file_digest(path: Path) -> str:
    info = path.stat()
    key = (str(path), info.st_size, info.st_mtime_ns, info.st_ctime_ns)
    if key not in _INTEGRITY_CACHE:
        digest = hashlib.sha256()
        with path.open('rb') as source:
            for block in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(block)
        _INTEGRITY_CACHE[key] = digest.hexdigest()
    return _INTEGRITY_CACHE[key]

def status() -> dict:
    required = [RUNTIME / '.venv/bin/python', ROOT / 'server/rosvot_runner.py',
                RUNTIME / 'source/inference/rosvot.py', RUNTIME / 'source/LICENSE',
                RUNTIME / 'weights-manifest.json',
                *[RUNTIME / f'checkpoints/{m}/config.yaml' for m in ('rosvot','rwbd')],
                *[RUNTIME / f'checkpoints/{m}/model.pt' for m in ('rosvot','rwbd','rmvpe')]]
    missing = [str(p) for p in required if not p.is_file()]
    integrity_errors = []
    if not missing:
        try:
            manifest = json.loads((RUNTIME / 'weights-manifest.json').read_text())
            for model in ('rosvot','rwbd','rmvpe'):
                relative = f'models/rosvot/checkpoints/{model}/model.pt'
                entry = manifest[relative]
                path = ROOT / relative
                if path.stat().st_size != entry['bytes'] or _file_digest(path) != entry['sha256']:
                    integrity_errors.append(f'{model} checkpoint integrity mismatch')
        except (OSError, ValueError, KeyError, TypeError) as error:
            integrity_errors.append(f'Invalid weights manifest: {error}')
    return {'ready': not missing and not integrity_errors, 'missing': missing,
            'integrityErrors': integrity_errors, 'engine': 'ROSVOT + RWBD + RMVPE',
            'sourceCommit': '3c8332bf43adae35f6e4d64971862f2f6139b310', 'defaultDevice': 'cpu'}


def _stop_process(process) -> None:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def _stitch_context_events(events: list[dict]) -> list[dict]:
    """Join only a context-proven continuation, never a predicted reattack."""
    stitched = []
    for original in events:
        event = dict(original)
        if (stitched and stitched[-1]['chunk'] != event['chunk']
            and stitched[-1]['continues_into_context'] and event['continued_from_context']
            and stitched[-1]['midi_pitch'] == event['midi_pitch']
            and abs(stitched[-1]['end_seconds']-event['start_seconds']) <= .006):
            previous = stitched[-1]
            previous['end_seconds'] = event['end_seconds']
            previous.setdefault('stitched_chunks',[previous['chunk']]).append(event['chunk'])
            previous['chunk'] = event['chunk']
            previous['continues_into_context'] = event['continues_into_context']
        else:
            stitched.append(event)
    return stitched

def transcribe_many(requests: list[dict], output_dir: str | Path, *, device: str = 'cpu',
                    chunk_seconds: float = 60., context_seconds: float = 3.,
                    timeout_seconds: float = 1800., cancel_check=None) -> dict:
    """Run requests {id,audio_path,start_seconds?,end_seconds?,source_offset_seconds?}.

    Emits per-request JSON {events:[{start_seconds,end_seconds,midi_pitch,rest,...}]}.
    `start_seconds`/`end_seconds` select source samples, while source_offset_seconds
    locates an already-cropped input on its parent's timeline. No grid snapping,
    pitch merging, rest deletion, or post-hoc threshold tuning is performed here.
    """
    import soundfile as sf
    if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
        raise ValueError('timeout_seconds must be finite and positive')
    health = status()
    if not health['ready']:
        raise RuntimeError(f"ROSVOT unavailable: {health}")
    if not requests:
        raise ValueError('At least one audio request is required')
    if cancel_check and cancel_check():
        raise InterruptedError('ROSVOT cancelled')
    if device not in ('cpu','mps'):
        raise ValueError('ROSVOT local device must be cpu or mps')
    if not (1 <= chunk_seconds <= 140 and 0 <= context_seconds <= 8 and chunk_seconds+2*context_seconds < 159):
        raise ValueError('Chunk plus context must stay below 159 seconds (30000 model frames)')
    out = Path(output_dir).resolve(); out.mkdir(parents=True,exist_ok=True)
    inputs = out/'inputs';inputs.mkdir(exist_ok=True)
    items=[]; tracks={};started=time.perf_counter()
    for index,req in enumerate(requests):
        identifier=str(req.get('id',f'track_{index}'))
        if identifier in tracks or not identifier or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for c in identifier):
            raise ValueError('Request IDs must be unique ASCII letters/digits/underscore/hyphen')
        path=Path(req['audio_path']).resolve();info=sf.info(path)
        begin=float(req.get('start_seconds',0));end=float(req.get('end_seconds',info.duration));offset=float(req.get('source_offset_seconds',0))
        if not all(math.isfinite(x) for x in (begin,end,offset)) or not 0 <= begin < end <= info.duration+.0001:
            raise ValueError('Invalid audio source interval')
        tracks[identifier]={'id':identifier,'audio_path':str(path),'start_seconds':begin+offset,'end_seconds':end+offset,'chunks':[]}
        count=math.ceil((end-begin)/chunk_seconds)
        for chunk in range(count):
            if cancel_check and cancel_check():
                raise InterruptedError('ROSVOT cancelled')
            core_a=begin+chunk*chunk_seconds;core_b=min(end,core_a+chunk_seconds)
            a=max(begin,core_a-context_seconds);b=min(end,core_b+context_seconds)
            a_frame=round(a*info.samplerate);b_frame=round(b*info.samplerate)
            with sf.SoundFile(path) as audio:
                audio.seek(a_frame);samples=audio.read(b_frame-a_frame,dtype='float32')
            name=f'{identifier}__{chunk:04d}';clip=inputs/(name+'.wav')
            if clip.resolve() == path:
                raise ValueError('ROSVOT output would overwrite the source audio')
            sf.write(clip,samples,info.samplerate,subtype='FLOAT')
            item={'item_name':name,'wav_fn':str(clip),'track_id':identifier,
                  'source_file':str(path),'source_start_seconds':a_frame/info.samplerate+offset,
                  'source_end_seconds':b_frame/info.samplerate+offset,
                  'core_start_seconds':core_a+offset,'core_end_seconds':core_b+offset}
            items.append(item);tracks[identifier]['chunks'].append(name)
    manifest=out/'manifest.json';manifest.write_text(json.dumps(items,ensure_ascii=False,indent=2))
    cmd=[str(RUNTIME/'.venv/bin/python'),str(ROOT/'server/rosvot_runner.py'),'--metadata',str(manifest),
         '--ckpt',str(RUNTIME/'checkpoints/rosvot/model.pt'),'--wbd_ckpt',str(RUNTIME/'checkpoints/rwbd/model.pt'),
         '-o',str(out/'native'),'--ds_workers','0','--bsz','1','--max_tokens','30000']
    env=os.environ|{'PYTHONPATH':str(RUNTIME/'source'),'ROSVOT_DEVICE':device,'ROSVOT_THREADS':'4'}
    with (out/'inference.log').open('w') as log:
        process=subprocess.Popen(cmd,cwd=RUNTIME/'source',env=env,stdout=log,stderr=subprocess.STDOUT)
        infer_started=time.monotonic()
        try:
            while process.poll() is None:
                if cancel_check and cancel_check():
                    raise InterruptedError('ROSVOT cancelled')
                if time.monotonic()-infer_started > timeout_seconds:
                    raise TimeoutError('ROSVOT timeout')
                time.sleep(.2)
        finally:
            _stop_process(process)
    if process.returncode:
        raise RuntimeError(f"ROSVOT inference failed ({process.returncode}); see {out/'inference.log'}")
    for item in items:
        native=json.loads((out/'native'/(item['item_name']+'.intervals.json')).read_text())
        track=tracks[item['track_id']];track.setdefault('events',[]);track.setdefault('word_boundaries_seconds',[])
        core_a=item['core_start_seconds'];core_b=item['core_end_seconds']
        for event in native['events']:
            a=max(core_a,event['source_start_seconds']);b=min(core_b,event['source_end_seconds'])
            if b-a<=1e-6:continue
            track['events'].append({'start_seconds':a,'end_seconds':b,'midi_pitch':event['midi_pitch'],'rest':event['rest'],
                'chunk':item['item_name'],'continued_from_context':event['source_start_seconds']<core_a-1e-6,
                'continues_into_context':event['source_end_seconds']>core_b+1e-6,
                'boundary_probability':event.get('boundary_probability') if a == event['source_start_seconds'] else None,
                'boundary_probability_kind':'uncalibrated model note boundary sigmoid; null on artificial chunk cuts' if event.get('boundary_probability') is not None else None})
        track['word_boundaries_seconds'] += [t+item['source_start_seconds'] for t in native['word_boundaries_seconds'] if core_a <= t+item['source_start_seconds'] < core_b]
    for identifier,track in tracks.items():
        track['events']=_stitch_context_events(track['events'])
        for event in track['events']:
            event['source_start_seconds']=event['start_seconds']
            event['source_end_seconds']=min(track['end_seconds'],event['end_seconds'])
            event['end_seconds']=event['source_end_seconds']
        for index, event in enumerate(track['events']):
            if not (math.isfinite(event['start_seconds']) and math.isfinite(event['end_seconds'])
                    and track['start_seconds']-1e-6 <= event['start_seconds'] < event['end_seconds'] <= track['end_seconds']+1e-6):
                raise RuntimeError('ROSVOT returned an invalid or out-of-bounds note interval')
            if index and track['events'][index-1]['end_seconds'] > event['start_seconds']+1e-6:
                raise RuntimeError('ROSVOT returned overlapping monophonic intervals')
        track['engine']='ROSVOT + learned RWBD + RMVPE';track['device']=device
        track['chunk_seconds']=chunk_seconds;track['context_seconds']=context_seconds
        track['statistics']={'all_events':len(track['events']),'voiced_notes':sum(not e['rest'] for e in track['events']),'rest_events':sum(e['rest'] for e in track['events'])}
        track['artifact_path']=str(out/(identifier+'.json'))
        (out/(identifier+'.json')).write_text(json.dumps(track,ensure_ascii=False,indent=2))
    report={'success':True,'elapsed_seconds':time.perf_counter()-started,'native_run':json.loads((out/'native/run.json').read_text()),'tracks':tracks}
    (out/'run.json').write_text(json.dumps({k:v for k,v in report.items() if k!='tracks'}|{'tracks':{k:{'artifact_path':v['artifact_path'],'statistics':v['statistics']} for k,v in tracks.items()}},ensure_ascii=False,indent=2))
    return report

def transcribe(audio_path: str | Path, output_dir: str | Path, **kwargs) -> dict:
    """Single full audio request; return the absolute-second events and rests."""
    return transcribe_many([{'id':'lead','audio_path':str(audio_path)}],output_dir,**kwargs)['tracks']['lead']


def runtime_health() -> dict:
    return status()

def infer_rosvot(audio_path: Path, output: Path, *, timeout_seconds: float = 1800., cancel_check=None) -> dict:
    """Product API: absolute source seconds, pitch/rest, native boundary evidence."""
    return transcribe(audio_path,output,timeout_seconds=timeout_seconds,cancel_check=cancel_check)

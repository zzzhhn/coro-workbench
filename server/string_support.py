"""Sequential, content-bound supporting inference for sustained strings."""
import hashlib
from pathlib import Path
import subprocess
import time

from . import config
from .storage import atomic_json,read_json

VERSION='string-support-models-1'


def signature(mixture,paths):
    def digest(path):
        h=hashlib.sha256()
        with Path(path).open('rb') as stream:
            for block in iter(lambda:stream.read(1024*1024),b''):h.update(block)
        return h.hexdigest()
    return {'version':VERSION,'mixtureSha256':digest(mixture),
            'vocalSha256':digest(paths['vocals']),'otherSha256':digest(paths['other'])}


def cached_support(directory,mixture,paths):
    if not all((directory/n).is_file() for n in ('manifest.json','basic-pitch.json','instrumental-events.json')):
        return None
    try:
        if read_json(directory/'manifest.json')!=signature(mixture,paths):return None
        basic=read_json(directory/'basic-pitch.json')['events']
        instrumental=read_json(directory/'instrumental-events.json')['events']
        if not isinstance(basic,list) or not isinstance(instrumental,list):return None
        return basic,instrumental
    except (OSError,ValueError,KeyError,TypeError):
        # A cancelled/failed supporting pass must never poison the full job.
        return None


def ensure_support(directory,mixture,paths,status):
    import soundfile as sf
    directory.mkdir(exist_ok=True,parents=True)
    if cached_support(directory,mixture,paths) is not None:return
    identity=signature(mixture,paths)
    # Preserve phase and gain when excluding vocals. Never subtract magnitudes
    # or normalize the stems independently before building this input.
    target=directory/'instrumental.wav'
    with sf.SoundFile(mixture) as mix,sf.SoundFile(paths['vocals']) as voice:
        if (mix.samplerate,mix.channels,mix.frames)!=(voice.samplerate,voice.channels,voice.frames):
            raise ValueError('String support requires sample-aligned original and vocal waveforms')
        with sf.SoundFile(target,'w',samplerate=mix.samplerate,channels=mix.channels,subtype='FLOAT') as out:
            while mix.tell()<mix.frames:
                status.check_cancelled()
                out.write(mix.read(65536,dtype='float32',always_2d=True)-voice.read(65536,dtype='float32',always_2d=True))
    status.update(94,'source-check','正在复核伴奏中的弦乐类别和持续音，保留钢琴与人声的同音对照。')
    command=[str(config.MODELS_DIR/'yourmt3/.venv/bin/python'),str(config.ROOT/'server/yourmt3_runner.py'),
             '--source',str(config.MODELS_DIR/'yourmt3'),'--audio',str(target),
             '--output',str(directory/'instrumental-events.json'),'--progress',str(directory/'progress.json')]
    with (directory/'instrumental.log').open('w') as log:
        process=subprocess.Popen(command,cwd=config.ROOT,stdout=log,stderr=log)
        try:
            deadline=time.monotonic()+max(180,sf.info(target).duration*12)
            while process.poll() is None:
                status.check_cancelled()
                if time.monotonic()>deadline:raise TimeoutError('String support inference timed out')
                time.sleep(.2)
            if process.returncode:raise RuntimeError('Instrumental string support inference failed')
        finally:
            if process.poll() is None:process.kill()
            process.wait()
    from basic_pitch.inference import Model,predict
    import onnxruntime as ort
    model=Model.__new__(Model);model.model_type=Model.MODEL_TYPES.ONNX
    options=ort.SessionOptions();options.intra_op_num_threads=2;options.inter_op_num_threads=1
    model.model=ort.InferenceSession(str(config.basic_pitch_path()),sess_options=options,providers=['CPUExecutionProvider'])
    status.check_cancelled()
    _,_,notes=predict(paths['other'],model_or_model_path=model,onset_threshold=.5,frame_threshold=.3,
                      minimum_note_length=100,multiple_pitch_bends=False)
    atomic_json(directory/'basic-pitch.json',{'events':[
        dict(start=float(n[0]),end=float(n[1]),midi=int(n[2]),activation=float(n[3])) for n in notes]})
    status.check_cancelled()
    atomic_json(directory/'manifest.json',identity)

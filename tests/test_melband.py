import hashlib
import json
from pathlib import Path
import numpy as np
import pytest
import soundfile as sf
from server import melband


class Process:
    def __init__(self,code=None):self.returncode=code;self.terminated=False
    def poll(self):return self.returncode
    def terminate(self):self.terminated=True
    def wait(self,timeout):self.returncode=-15;return self.returncode
    def kill(self):self.returncode=-9


def audio(tmp_path,name='input.wav'):
    path=tmp_path/name
    sf.write(path,np.full((1600,2),.1,np.float32),16000,subtype='FLOAT')
    return path


def prepare(monkeypatch,tmp_path):
    source=audio(tmp_path);process=Process()
    monkeypatch.setattr(melband,'runtime_health',lambda:{'ready':True})
    monkeypatch.setattr(melband.subprocess,'Popen',lambda *a,**k:process)
    return source,process


@pytest.mark.parametrize('seconds',[0,-1,float('inf'),float('nan')])
def test_invalid_timeout_has_no_side_effect(tmp_path,seconds):
    with pytest.raises(ValueError):melband.separate_vocals(tmp_path/'absent',tmp_path/'out',timeout_seconds=seconds)
    assert not (tmp_path/'out').exists()


@pytest.mark.parametrize('name',['vocals.wav','instrumental.wav','separation.json','inference.log'])
@pytest.mark.parametrize('alias',['symlink','hardlink'])
def test_output_alias_cannot_overwrite_source(tmp_path,name,alias):
    source=audio(tmp_path)
    out=tmp_path/'out';out.mkdir()
    if alias=='symlink':(out/name).symlink_to(source)
    else:(out/name).hardlink_to(source)
    before=source.read_bytes()
    with pytest.raises(ValueError,match='overwrite'):melband.separate_vocals(source,out)
    assert source.read_bytes()==before


def test_cancel_callback_exception_reaps_child(monkeypatch,tmp_path):
    source,process=prepare(monkeypatch,tmp_path);calls=[]
    def cancelled():
        calls.append(1)
        if len(calls)>1:raise InterruptedError('job cancelled')
        return False
    with pytest.raises(InterruptedError):melband.separate_vocals(source,tmp_path/'out',cancel_check=cancelled)
    assert process.terminated and process.returncode is not None


def test_timeout_reaps_child(monkeypatch,tmp_path):
    source,process=prepare(monkeypatch,tmp_path)
    clock=iter([0.,2.]);monkeypatch.setattr(melband.time,'monotonic',lambda:next(clock))
    with pytest.raises(TimeoutError):melband.separate_vocals(source,tmp_path/'out',timeout_seconds=.1)
    assert process.terminated


def test_unavailable_engine_preserves_input(monkeypatch,tmp_path):
    source=audio(tmp_path);before=source.read_bytes()
    monkeypatch.setattr(melband,'runtime_health',lambda:{'ready':False})
    with pytest.raises(RuntimeError,match='unavailable'):melband.separate_vocals(source,tmp_path/'out')
    assert source.read_bytes()==before and not (tmp_path/'out').exists()


@pytest.mark.parametrize('bad_frames',[False,True])
def test_validates_time_format_and_float_headroom(monkeypatch,tmp_path,bad_frames):
    source=audio(tmp_path);out=tmp_path/'out';before=hashlib.sha256(source.read_bytes()).hexdigest()
    monkeypatch.setattr(melband,'runtime_health',lambda:{'ready':True})
    def launch(*args,**kwargs):
        sf.write(out/'vocals.wav',np.full((1599 if bad_frames else 1600,2),1.25,np.float32),16000,subtype='FLOAT')
        sf.write(out/'instrumental.wav',np.zeros((1600,2),np.float32),16000,subtype='FLOAT')
        (out/'separation.json').write_text(json.dumps({'input':{'sha256':before},'device':'cpu'}))
        return Process(0)
    monkeypatch.setattr(melband.subprocess,'Popen',launch)
    if bad_frames:
        with pytest.raises(RuntimeError,match='timing/format'):melband.separate_vocals(source,out)
    else:
        result=melband.separate_vocals(source,out)
        assert result['paths']['vocals']==str(out/'vocals.wav')
        assert sf.read(out/'vocals.wav')[0].max()==1.25
        assert result['sourceChanged'] is False
    assert hashlib.sha256(source.read_bytes()).hexdigest()==before


def test_health_rejects_modified_weights(monkeypatch,tmp_path):
    runtime=tmp_path/'runtime'
    monkeypatch.setattr(melband,'RUNTIME',runtime);monkeypatch.setattr(melband,'ROOT',tmp_path)
    for rel in ['.venv/bin/python','source/models/mel_band_roformer/mel_band_roformer.py','source/utils.py','MelBandRoformer.ckpt','source/configs/config_vocals_mel_band_roformer.yaml']:
        p=runtime/rel;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b'known')
    (tmp_path/'server').mkdir();(tmp_path/'server/melband_runner.py').touch()
    digest=hashlib.sha256(b'known').hexdigest()
    monkeypatch.setattr(melband,'CHECKPOINT_SHA256',digest);monkeypatch.setattr(melband,'CONFIG_SHA256',digest)
    assert melband.runtime_health()['ready']
    (runtime/'MelBandRoformer.ckpt').write_bytes(b'changed')
    assert not melband.runtime_health()['ready']
    assert melband.runtime_health()['integrityErrors']

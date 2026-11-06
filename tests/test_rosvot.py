import hashlib
import json
from pathlib import Path
import numpy as np
import pytest
import soundfile as sf
from server import rosvot


def event(a,b,chunk,*,left=False,right=False,pitch=60):
    return dict(start_seconds=a,end_seconds=b,chunk=chunk,continued_from_context=left,
                continues_into_context=right,midi_pitch=pitch,rest=pitch is None)


def test_context_sustained_note_stitches_without_new_attack():
    result=rosvot._stitch_context_events([event(59.8,60,'a',right=True),event(60,60.4,'b',left=True)])
    assert len(result)==1 and result[0]['start_seconds']==59.8 and result[0]['end_seconds']==60.4


def test_same_pitch_reattack_at_seam_is_preserved():
    result=rosvot._stitch_context_events([event(59.9,60,'a'),event(60,60.12,'b')])
    assert len(result)==2
    assert len(rosvot._stitch_context_events([event(59.9,60,'a',right=True),event(60,60.12,'b')]))==2


class Process:
    returncode=None
    terminated=False
    killed=False
    def poll(self):return self.returncode
    def terminate(self):self.terminated=True
    def kill(self):self.killed=True
    def wait(self,timeout):self.returncode=-15;return self.returncode


def prepare(monkeypatch,tmp_path):
    path=tmp_path/'input.wav';sf.write(path,np.ones(800,dtype=np.float32)*.01,8000)
    process=Process()
    monkeypatch.setattr(rosvot,'status',lambda:{'ready':True})
    monkeypatch.setattr(rosvot.subprocess,'Popen',lambda *a,**kw:process)
    return path,process


def test_callback_exception_reaps_inference_child(monkeypatch,tmp_path):
    path,process=prepare(monkeypatch,tmp_path);calls=[]
    class Cancelled(Exception):pass
    def callback():
        calls.append(1)
        if len(calls)>2:raise Cancelled('cancelled by job')
    with pytest.raises(Cancelled):rosvot.infer_rosvot(path,tmp_path/'out',cancel_check=callback)
    assert process.terminated and process.returncode is not None


def test_timeout_reaps_inference_child(monkeypatch,tmp_path):
    path,process=prepare(monkeypatch,tmp_path)
    values=iter([0.,2.]);monkeypatch.setattr(rosvot.time,'monotonic',lambda:next(values))
    with pytest.raises(TimeoutError):rosvot.infer_rosvot(path,tmp_path/'out',timeout_seconds=.5)
    assert process.terminated and process.returncode is not None


@pytest.mark.parametrize('seconds',[0,-1,float('nan'),float('inf')])
def test_invalid_timeout_rejected_before_inference(tmp_path,seconds):
    with pytest.raises(ValueError):rosvot.infer_rosvot(tmp_path/'absent.wav',tmp_path/'out',timeout_seconds=seconds)


def test_refuses_to_overwrite_source_clip(monkeypatch,tmp_path):
    out=tmp_path/'out';(out/'inputs').mkdir(parents=True)
    path=out/'inputs/lead__0000.wav';sf.write(path,np.ones(800)*.01,8000)
    before=hashlib.sha256(path.read_bytes()).hexdigest()
    monkeypatch.setattr(rosvot,'status',lambda:{'ready':True})
    with pytest.raises(ValueError,match='overwrite'):rosvot.infer_rosvot(path,out)
    assert hashlib.sha256(path.read_bytes()).hexdigest()==before


def test_health_detects_changed_checkpoint_and_missing_source(monkeypatch,tmp_path):
    runtime=tmp_path/'models/rosvot';monkeypatch.setattr(rosvot,'ROOT',tmp_path);monkeypatch.setattr(rosvot,'RUNTIME',runtime)
    manifest={}
    for model in ('rosvot','rwbd','rmvpe'):
        path=runtime/f'checkpoints/{model}/model.pt';path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(model.encode())
        manifest[str(path.relative_to(tmp_path))]={'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
    for relative in ['.venv/bin/python','source/inference/rosvot.py','source/LICENSE','checkpoints/rosvot/config.yaml','checkpoints/rwbd/config.yaml']:
        path=runtime/relative;path.parent.mkdir(parents=True,exist_ok=True);path.touch()
    (tmp_path/'server').mkdir();(tmp_path/'server/rosvot_runner.py').touch()
    (runtime/'weights-manifest.json').write_text(json.dumps(manifest))
    assert rosvot.runtime_health()['ready']
    (runtime/'checkpoints/rosvot/model.pt').write_bytes(b'ROSVOT')
    assert not rosvot.runtime_health()['ready']
    assert rosvot.runtime_health()['integrityErrors']
    (runtime/'source/inference/rosvot.py').unlink()
    assert not rosvot.runtime_health()['ready']

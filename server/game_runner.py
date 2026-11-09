"""Isolated GAME 1.0.3 ONNX inference. Accepts fresh audio, never reference scores."""
from pathlib import Path
import argparse, hashlib, importlib.util, json, resource, subprocess, time
import numpy as np
import onnxruntime as ort

HERE = Path(__file__).resolve().parent

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--audio', type=Path, required=True)
    p.add_argument('--model', type=Path, required=True)
    p.add_argument('--source', type=Path, required=True)
    p.add_argument('--language', choices=('zh','en','ja','yue'), default='zh')
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--start', type=float, default=0)
    p.add_argument('--seconds', type=float)
    p.add_argument('--steps', type=int, default=8)
    p.add_argument('--max-chunk-seconds', type=float, default=18,
                   help='Maximum unsplit silence-delimited phrase; set 0 to use official silence chunks intact.')
    args = p.parse_args()
    if args.steps < 1: p.error('--steps must be positive')
    cfg=json.loads((args.model/'config.json').read_text()); sr=cfg['samplerate']
    cmd=['ffmpeg','-v','error','-nostdin','-ss',str(args.start),'-i',str(args.audio)]
    if args.seconds: cmd += ['-t',str(args.seconds)]
    cmd += ['-f','f32le','-ac','1','-ar',str(sr),'-']
    wave=np.frombuffer(subprocess.run(cmd,capture_output=True,check=True).stdout,dtype='<f4').copy()
    opt=ort.SessionOptions();opt.intra_op_num_threads=2;opt.inter_op_num_threads=1
    ort.set_seed(20261107)
    sessions={n:ort.InferenceSession(str(args.model/(n+'.onnx')),opt,providers=['CPUExecutionProvider'])
              for n in ['encoder','segmenter','estimator','dur2bd','bd2dur']}
    def run(name,**inputs): return sessions[name].run(None,inputs)
    spec=importlib.util.spec_from_file_location('official_slicer',args.source/'inference/slicer2.py')
    mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
    chunks=mod.Slicer(sr=sr,threshold=-40,min_length=1000,min_interval=200,max_sil_kept=100).slice(wave)
    print(json.dumps({'duration':len(wave)/sr,'chunks':len(chunks),'maxChunk':max((len(c['waveform'])/sr for c in chunks),default=0)}),flush=True)
    # Long unsliced passages use overlapping context and onset ownership;
    # these seams remain explicit in the evidence rather than hidden merges.
    jobs=[]
    for c in chunks:
        length=len(c['waveform'])/sr
        if not args.max_chunk_seconds or length<=args.max_chunk_seconds:
            jobs.append((c['offset'],c['waveform'],0.,length))
        else:
            for core in np.arange(0,length,12):
                left=max(0.,core-2);right=min(length,core+14)
                jobs.append((c['offset']+left,c['waveform'][round(left*sr):round(right*sr)],core-left,min(length,core+12)-left))
    events=[];segments=[];started=time.monotonic()
    for index,(offset,y,keep_start,keep_end) in enumerate(jobs):
        duration=np.array([len(y)/sr],np.float32)
        xseg,xest,mask=run('encoder',waveform=y[None].astype(np.float32),duration=duration)
        known,=run('dur2bd',durations=duration[:,None],maskT=mask)
        boundaries=known
        for t in np.arange(args.steps,dtype=np.float32)/args.steps:
            boundaries,=run('segmenter',x_seg=xseg,language=np.array([cfg['languages'][args.language]],np.int64),
                           known_boundaries=known,prev_boundaries=boundaries,t=np.array([t],np.float32),maskT=mask,
                           threshold=np.array(.2,np.float32),radius=np.array(2,np.int64))
        durations,nmask=run('bd2dur',boundaries=boundaries,maskT=mask)
        presence,scores=run('estimator',x_est=xest,boundaries=boundaries,maskT=mask,maskN=nmask,threshold=np.array(.2,np.float32))
        assert np.all(np.isfinite(scores)) and np.all(durations>=0)
        assert abs(float(durations.sum())-float(duration[0])) <= cfg['timestep']*1.1
        cursor=0.; records=[]
        for d,voiced,score,valid in zip(durations[0],presence[0],scores[0],nmask[0]):
            if not valid: continue
            left=cursor;cursor+=float(d)
            records.append({'start':left,'end':cursor,'voiced':bool(voiced),'midiFloat':float(score)})
            if voiced and keep_start<=left<keep_end:
                events.append({'start':args.start+offset+left,'end':args.start+offset+cursor,
                               'midi':int(np.rint(score)),'midiFloat':float(score),'segment':index})
        segments.append({'offsetSeconds':args.start+offset,'durationSeconds':float(duration[0]),
                         'ownedOnsets':[keep_start,keep_end],'regions':records})
        print(f'{index+1}/{len(jobs)} at {args.start+offset:.2f}s events={len(events)} elapsed={time.monotonic()-started:.1f}s',flush=True)
    events.sort(key=lambda e:e['start'])
    result={'model':args.model.name,'sourceAudio':str(args.audio.resolve()),
            'sourceSha256':hashlib.file_digest(args.audio.open('rb'),'sha256').hexdigest(),
            'modelHashes':{q.name:hashlib.file_digest(q.open('rb'),'sha256').hexdigest() for q in args.model.glob('*.onnx')},
            'provider':'CPUExecutionProvider','threads':2,'language':args.language,'steps':args.steps,'thresholds':[.2,.2],
            'maxChunkSeconds':args.max_chunk_seconds,
            'referenceUsed':False,'postprocessing':'round floating MIDI pitch only; no note deletion/merge/rhythm changes',
            'seconds':len(wave)/sr,'startSeconds':args.start,'elapsedSeconds':time.monotonic()-started,
            'peakRssBytes':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,'events':events,'segments':segments}
    result['runnerVersion']='game-import-1'
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')

if __name__=='__main__': main()

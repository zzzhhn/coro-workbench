"""Build a private three-way lyrics pilot; publication is an explicit flag.

Input inference is audio, frozen GAME events and aligned plain lyrics only.
Author MIDI is deliberately absent here. All arms share the neutral synthesizer.
"""
import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import uuid

import numpy as np
import yaml

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from server.lyric_score import interpret,infer_shared_vowel_words
from server.singing_score import VERSION,abstract_syllables,infer_score_rhythm,resolve_pitch_edges,restore_contour_tails,recover_short_syllable_anchors,mark_legato_transitions
from server.storage import atomic_json,utc_now

PREVIOUS=ROOT/'evidence/lyrics-assisted-20261108'
V2=ROOT/'evidence/lyrics-readable-20261108'
OUT=ROOT/'evidence/lyrics-phrasing-20261108'
RANGES=((13,36),(45,54))


def main(publish=False):
    source=ROOT/'evidence/vocal-ab-20261107/large-20261108/game-medium-k8-phrases.json'
    prior=ROOT/'evidence/pipeline-ab-20261108/review.json'
    aligned=PREVIOUS/'sofa/alignment.json'
    contour=ROOT/'data/p0-multiscore/private-konger/source-models/vocals-fcpe.npz'
    extra=OUT/'sofa/alignment.json'
    inputs={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in (source,prior,aligned,PREVIOUS/'segments.json',contour,V2/'review.json',extra,OUT/'segments-extra.json',
        ROOT/'server/singing_score.py',ROOT/'server/lyric_score.py',ROOT/'scripts/build-lyrics-pilot.py',ROOT/'scripts/build-pipeline-ab.py')}
    raw=json.loads(source.read_text()); data=json.loads(prior.read_text()); alignment=json.loads(aligned.read_text())
    grid=data['grid'];spb=60/grid['bpm'];origin=grid['offsetSeconds']
    current=json.loads((V2/'review.json').read_text())['variants']['lyrics']['project']
    baseline=data['candidate']['parts'][0]['notes']
    events=[dict(e,id=n['id']) for e,n in zip(raw['events'],baseline)]
    assert len(events)==len(baseline)
    audio=ROOT/'data/p0-multiscore/private-konger/separated/stem-vocals.wav'
    pcm=subprocess.check_output(['ffmpeg','-v','error','-i',str(audio),'-f','f32le','-ac','1','-ar','22050','-'])
    wave=np.frombuffer(pcm,dtype='<f4');sr=22050
    from server.singing_evidence import acoustic_evidence
    signals=acoustic_evidence(wave,sr,contour)
    energy=signals['energy']
    attack=signals['attack']
    pitch_support=signals['pitch_support']
    structural_attack=signals['structural_attack']
    pitch_runs=signals['pitch_runs']
    contour_pitch=signals['contour_pitch']
    short_contour_support=signals['short_contour_support']
    onset_pitch_spread=signals['onset_pitch_spread']
    hp=yaml.safe_load((ROOT/'models/sofa-mandarin/pretrained_mandarin_singing/hparams.yaml').read_text())
    vocab=yaml.safe_load(hp['vocab_text'])
    def nucleus_support(word,previous,start,end):
        segment=word['id'].rsplit('-',1)[0]
        path=PREVIOUS/f'sofa/{segment}-evidence.npz'
        inputs[str(path.relative_to(ROOT))]=hashlib.sha256(path.read_bytes()).hexdigest()
        with np.load(path,allow_pickle=False) as stored:
            logp=stored['logp'];t=float(stored['start'])+np.arange(len(logp))*float(stored['hop'])
        mask=(t>=start)&(t<end)
        nasal=vocab[word['phones'][0]['phone']]
        if mask.sum()<10:return None
        return {'familyMean':float(np.exp(logp[mask][:,[vocab['a'],nasal]]).sum(axis=1).mean()),
                'relativeNasal':float(np.exp(logp[mask,nasal]).mean()/max(1e-9,np.exp(logp[:,nasal]).mean()))}
    candidate=copy.deepcopy(current); ablation=copy.deepcopy(current)
    all_words=[w for segment in alignment['segments']+json.loads(extra.read_text())['segments'] for w in segment['words']]
    all_words.sort(key=lambda w:w['vowelStart'])
    replace_ids=set(); new_notes=[];ablation_notes=[];audits=[]
    for first,last in RANGES:
        lo=origin+first*4*spb;hi=origin+(last+1)*4*spb
        selected=[e for e in events if lo<=e['start']<hi]
        words=[w for w in all_words if lo-.10<=w['vowelStart']<hi]
        from server.singing_pipeline import build_singing_notes
        notes,phrase_audit=build_singing_notes(selected,words,grid,current['key'],signals,nucleus_support)
        control,control_timing=infer_score_rhythm(selected,grid,[])
        replace_ids.update(e['id'] for e in selected)
        new_notes.extend(notes);ablation_notes.extend(control)
        audits.append({'firstBar':first,'lastBar':last,'startSeconds':lo,'endSeconds':hi,
            **phrase_audit,'withoutLyricsTiming':control_timing})
    for project,notes in ((candidate,new_notes),(ablation,ablation_notes)):
        project['parts'][0]['notes']=sorted([copy.deepcopy(n) for n in current['parts'][0]['notes']
            if not any(first*4<=n['start']<(last+1)*4 for first,last in RANGES)]+notes,key=lambda n:n['start'])
        ns=project['parts'][0]['notes']
        collisions=[(a['id'],b['id']) for a,b in zip(ns,ns[1:]) if a['start']+a['duration']>b['start']+1e-6]
        if collisions:raise ValueError(f'Pilot boundary collided with frozen outside notes: {collisions}')
    native=copy.deepcopy(current)
    native['parts'][0]['notes']=[{'id':e['id'],'midi':e['midi'],'start':(e['start']-origin)/spb,
        'duration':(e['end']-e['start'])/spb,'velocity':.7,'origin':'transcribed'} for e in events]
    spec=importlib.util.spec_from_file_location('pilot_synth',ROOT/'scripts/build-pipeline-ab.py')
    helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
    OUT.mkdir(parents=True,exist_ok=True)
    titles={'raw':'原始 Medium','current':'跟唱谱 V2','lyrics':'跟唱谱 V3'}
    projects={'raw':native,'current':current,'lyrics':candidate}
    variants={}
    for key,project in projects.items():
        helper.synth(project['parts'][0]['notes'],grid,raw['seconds'],OUT/f'{key}.wav')
        variants[key]={'title':titles[key],'project':project,'audioUrl':f'http://127.0.0.1:8788/lyrics-v3/{key}.wav'}
    identifier=hashlib.sha256(json.dumps({'version':VERSION,'inputs':inputs,'candidate':candidate},sort_keys=True).encode()).hexdigest()
    windows=[]
    for first,last in RANGES:
        for a in range(first,last+1,4):
            b=min(last,a+3)
            windows.append({'firstBar':a,'lastBar':b,'startSeconds':origin+a*4*spb,'endSeconds':origin+(b+1)*4*spb})
    starts=[1,5,9,13,17,21,25,29,33,37,41,44,48,52,56,59,62,66,70]
    manifest={'id':identifier,'grid':grid,'duration':raw['seconds'],'variants':variants,'windows':windows,
        'originalUrl':'http://127.0.0.1:8788/original.wav','stemUrl':'http://127.0.0.1:8788/vocals.wav',
        'referencePages':[{'firstBar':a,'lastBar':starts[i+1]-1 if i+1<len(starts) else 70,
            'url':f'http://127.0.0.1:8788/reference/{i+1:02}.png'} for i,a in enumerate(starts)],
        'notes':['固定 GAME Medium 8 步及同一人声分轨；歌词来自你原谱的纯文字。对照为上一轮跟唱谱 V2。',
                 '本轮覆盖原谱第 13～36、45～54 小节；其余人声保持 V2。',
                 '原始 Medium 保留原始起止；三版使用相同中性音色。跟唱谱归纳有声学证据的起声滑音，尚待你试听验收。',
                 '共享元音的推断字界已记录为候选；没有按手扒谱填写音高或时值。上一版歌词候选另行保留。']}
    atomic_json(OUT/'review.json',manifest)
    atomic_json(OUT/'audit.json',{'version':VERSION,'id':identifier,'inputs':inputs,'ranges':audits,
        'referenceUsedForInference':False,'manualNoteEdits':0,'automaticPromotion':False,
        'ablation':'Same duration-aware notation without lyrics is saved separately; do not attribute all rhythmic changes to alignment.'})
    atomic_json(OUT/'without-lyrics-project.json',ablation)
    if publish:
        jobs_path=OUT/'formal-jobs.json'
        if jobs_path.exists():
            jobs=json.loads(jobs_path.read_text())
            if jobs['experimentId']!=identifier:raise ValueError('Candidate changed after publication; preserve old jobs and publish a new version explicitly')
        else:
            jobs={'experimentId':identifier,'jobs':{key:uuid.uuid4().hex for key in projects}}
            atomic_json(jobs_path,jobs)
        for key,project in projects.items():
            full=copy.deepcopy(data['ensembleSource'])
            lead=next(p for p in full['parts'] if p['role']=='lead')
            lead.update(copy.deepcopy(project['parts'][0]));lead['name']=titles[key];lead['shortName']='Vox'
            lead['stemUrl']='/api/audio/2a0d2474991741bfa58773387d4434e8/stem-vocals.wav'
            # Remove the empty virtual bar consistently. No notes are discarded;
            # absolute playback time remains offset + beat * secondsPerBeat.
            assert all(n['start']>=4-1e-6 for p in full['parts'] for n in p['notes'])
            for p in full['parts']:
                for n in p['notes']:n['start']-=4
            for c in full['chords']:c['start']-=4
            full['originalAudio']['offsetSeconds']+=4*spb
            full['measures']-=1
            job_id=jobs['jobs'][key];full['id']=job_id
            full['title']=f'空耳 · {titles[key]} · 词音对照 V3'
            full['createdAt']=full['updatedAt']=utc_now()
            full['source']={'kind':'audio','filename':'空耳.mp3','engine':f'GAME Medium 8 steps / {titles[key]}',
                'warnings':['歌词与乐句试验，仅原谱 13～36、45～54 小节，未人工改音符，待试听验收。']}
            directory=ROOT/'data'/job_id;directory.mkdir(exist_ok=True)
            atomic_json(directory/'project.json',full)
            atomic_json(directory/'quality-evidence.json',{'experimentId':identifier,'variant':key,'ranges':RANGES,'manualNoteEdits':0})
            atomic_json(directory/'request.json',{'action':'lyrics-assisted-game-medium-review','mode':'multi',
                'filename':'空耳.mp3','max_seconds':raw['seconds'],'comparisonVariant':key})
            atomic_json(directory/'status.json',{'id':job_id,'status':'complete','progress':100,'stage':'complete',
                'message':'歌词辅助三方对照已生成，待人工听辨','createdAt':utc_now(),'updatedAt':utc_now(),'project':full})
    print(json.dumps({'id':identifier,'counts':{k:len(v['parts'][0]['notes']) for k,v in projects.items()},
        'changes':[{**{k:a[k] for k in ('firstBar','lastBar')},'actions':{action:sum(x['action']==action for x in a['interpretation']['decisions']) for action in set(x['action'] for x in a['interpretation']['decisions'])}} for a in audits],
        'published':publish},ensure_ascii=False))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--publish',action='store_true')
    main(parser.parse_args().publish)

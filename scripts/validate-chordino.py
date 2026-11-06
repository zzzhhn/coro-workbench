"""Run pinned Chordino on authored fixture audio and four saved local mixtures."""
from __future__ import annotations
import csv
import hashlib
import json
from pathlib import Path
import sys
from time import monotonic

import numpy as np
import soundfile as sf
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from server.chordino import infer_chordino, runtime_health

OUTPUT=ROOT/'data/phase5/chordino'
JOBS=[('Ariana - bye','f70ebab316d54d62abb0f56d19e0356e'),('NewJeans - Attention','22d62c8049d04e39b9062b60513bf9c5'),('Weeknd - Out of Time','1eac4381bbfd4904a66bf0ca97e2f72d'),('单依纯 - 空耳','a6be0eb965d048a0ad57819135164463')]


def sha(path):
 with Path(path).open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()


def save(path,data):
 path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')


def quality(label):
 # Evaluation-only mapping; no nearest-template selection or inferred key.
 suffix=label.split('/',1)[0]
 if suffix=='N':return 'N'
 if ':min' in suffix or suffix.endswith(('m','m7','m6')):return 'min'
 if ':dim' in suffix or ':aug' in suffix or ':hdim' in suffix or 'sus' in suffix or suffix.endswith(('dim','dim7','aug','m7b5')):return 'unsupported'
 return 'maj'


def fixture_score(segments,truth):
 names={'C':0,'C#':1,'Db':1,'D':2,'Eb':3,'E':4,'F':5,'F#':6,'Gb':6,'G':7,'Ab':8,'A':9,'Bb':10,'B':11}
 duration=truth['durationSeconds'];grid=np.arange(0,duration,.01);correct=shared=shared_total=n_correct=n_total=0;confusion={}
 for t in grid:
  expected=next(v for v in truth['notes'] if v['startSeconds']<=t<v['endSeconds'])['expectedSymbol']
  predicted=next((v for v in segments if v['sourceStartSeconds']<=t<v['sourceEndSeconds']),None)
  observed=predicted['symbol'].split('/',1)[0] if predicted else 'MISSING'
  correct+=observed==expected
  expected_kind=quality(expected)
  if expected=='N':
   n_total+=1;n_correct+=observed=='N'
  # Only explicitly authored plain triads/N are eligible for the shared maj/min set.
  root_name=expected[:2] if len(expected)>1 and expected[1] in '#b' else expected[:1]
  simple=expected=='N' or expected in {root_name,root_name+'m'}
  if simple:
   shared_total+=1
   if expected=='N':shared+=observed=='N'
   elif predicted is not None:shared+=predicted['root']==names[root_name] and quality(predicted.get('upstreamLabel',observed))==expected_kind
  if observed!=expected:confusion[expected+' → '+observed]=confusion.get(expected+' → '+observed,0)+1
 return {'scoreMeaning':'10ms duration-weighted authored fixture labels only, full duration includes transitions and terminal N; not song accuracy','durationSeconds':duration,'exactSymbolAccuracy':correct/len(grid),'plainTriadOrNSeconds':shared_total*.01,'sharedMajMinNAccuracyOnPlainTriadsOnly':shared/shared_total if shared_total else None,'NRecall':n_correct/n_total if n_total else None,'mismatchSeconds':{k:round(v*.01,2) for k,v in sorted(confusion.items(),key=lambda kv:-kv[1])}}


def fixture_rows():
 rows=[]
 for name in ['development-synthetic','development-piano','heldout-synthetic','heldout-guitar']:
  directory=ROOT/'data/phase3/harmony-fixtures'/name
  truth=json.loads((directory/'truth.json').read_text())
  piano,sr=sf.read(directory/'piano.wav',dtype='float32');bass,_=sf.read(directory/'bass.wav',dtype='float32')
  target=OUTPUT/'fixture-runs'/name;target.mkdir(parents=True,exist_ok=True)
  sf.write(target/'accompaniment.wav',piano+bass,sr,subtype='FLOAT')
  for config,source in [('accompaniment',target/'accompaniment.wav'),('competing-lead-mixture',directory/'mix-with-excluded-melody.wav')]:
   result=infer_chordino(source,target/config)
   row={'fixture':name,'input':config,'truthSha256':sha(directory/'truth.json'),'inputSha256':sha(source),'events':len(result['segments']),'runtimeSeconds':result['runtimeSeconds'],**fixture_score(result['segments'],truth)}
   rows.append(row);print(json.dumps(row,ensure_ascii=False),flush=True)
 return rows


def real_rows():
 rows=[]
 for name,job in JOBS:
  directory=ROOT/'data'/job;status=directory/'status.json';project=json.loads(status.read_text())['project'];before=sha(status)
  # Original mix and accompaniment are actual audio, never decoded note synthesis.
  paths=[directory/f'stem-{stem}.wav' for stem in ['piano','guitar','bass','other']]
  stem_hashes={p.name:sha(p) for p in paths}
  samples,sr=sf.read(paths[0],dtype='float32',always_2d=True)
  for path in paths[1:]:samples+=sf.read(path,dtype='float32',always_2d=True)[0]
  target=OUTPUT/'real'/job;target.mkdir(parents=True,exist_ok=True)
  accompaniment=target/'accompaniment.wav';sf.write(accompaniment,samples,sr,subtype='FLOAT')
  for config,source in [('original-mixture',directory/'original.wav'),('accompaniment',accompaniment)]:
   result=infer_chordino(source,target/config,bpm=project['originalAudio']['tempo'],offset_seconds=project['originalAudio'].get('offsetSeconds',0))
   segments=result['segments'];duration=result['input']['sourceEndSeconds'];n_seconds=sum(s['sourceEndSeconds']-s['sourceStartSeconds'] for s in segments if s['symbol']=='N')
   fixed=[]
   for start,end in [(0.,32.),(110.,140.)]:
    labels=[s for s in segments if s['sourceStartSeconds']<end and s['sourceEndSeconds']>start]
    fixed.append({'sourceRangeSeconds':[start,end],'intersectingSegments':len(labels),'NSeconds':sum(max(0,min(end,s['sourceEndSeconds'])-max(start,s['sourceStartSeconds'])) for s in labels if s['symbol']=='N'),'labels':[s['symbol'] for s in labels]})
   mapping=max((max(abs(project['originalAudio'].get('offsetSeconds',0)+s['start']*60/project['originalAudio']['tempo']-s['sourceStartSeconds']),abs(s['duration']*60/project['originalAudio']['tempo']-(s['sourceEndSeconds']-s['sourceStartSeconds']))) for s in segments),default=0)
   row={'song':name,'job':job,'input':config,'durationSeconds':duration,'events':len(segments),'NSeconds':n_seconds,'changesPerMinute':(len(segments)-1)*60/duration,'runtimeSeconds':result['runtimeSeconds'],'maxBeatToSourceErrorSeconds':mapping,'report':str((target/config/'harmony.json').relative_to(ROOT)),'sourceSha256':result['input']['sha256'],'stemHashes':stem_hashes if config=='accompaniment' else None,'fixedSlices':fixed,'groundTruthAvailable':False}
   rows.append(row);print(json.dumps(row,ensure_ascii=False),flush=True)
  assert sha(status)==before and all(sha(directory/name)==value for name,value in stem_hashes.items())
 return rows


if __name__=='__main__':
 started=monotonic();fixtures=fixture_rows();real=real_rows()
 report={'backend':runtime_health(),'wrapperSha256':sha(ROOT/'server/chordino.py'),'runnerSha256':sha(Path(__file__)),'fixtures':fixtures,'real':real,'runtimeSeconds':monotonic()-started,'sourceProjectsAndAudioUnchanged':True,'scope':'Full original/accompaniment mixtures of four songs, known authored fixture comparisons. No human chord truth for commercial songs; no production default change by this runner.'}
 save(ROOT/'evidence/phase5/chordino-validation.json',report)

from pathlib import Path
import json,numpy as np,mir_eval
from server.vocal_groundtruth import load_reference_notes
root=Path(__file__).resolve().parents[1];suite=root/'data/phase6/rosvot/full-suite';ids=['1','10','11','12','13','14','15','16'];rows=[]
for identifier in ids:
 d=json.loads((suite/f'vocadito_{identifier}.json').read_text());ev=[e for e in d['events'] if not e['rest']]
 ei=np.array([[e['start_seconds'],e['end_seconds']] for e in ev]);ep=np.array([440*2**((e['midi_pitch']-69)/12) for e in ev]);rr={}
 for ann in ['A1','A2']:
  ref=load_reference_notes(root/f'data/benchmarks/vocadito/Annotations/Notes/vocadito_{identifier}_notes{ann}.csv');ri=ref[:,:2];rp=ref[:,2]
  matches=mir_eval.transcription.match_notes(ri,rp,ei,ep,onset_tolerance=.3,offset_ratio=None)
  errors=[float(ei[j,0]-ri[i,0]) for i,j in matches]
  curve=[]
  for delay in np.arange(-.3,.30001,.005):
   shifted=np.maximum(ei+delay,0);valid=shifted[:,1]>shifted[:,0]
   matched=mir_eval.transcription.match_notes(ri,rp,shifted[valid],ep[valid],offset_ratio=None)
   curve.append({'delay':round(float(delay),3),'matches':len(matched),'f1':2*len(matched)/(len(ri)+len(ei))})
  pitch_only=mir_eval.transcription.match_notes(ri,rp,ei,ep,onset_tolerance=1e9,offset_ratio=None)
  onset=mir_eval.transcription.match_notes(ri,rp,ei,ep,offset_ratio=None,pitch_tolerance=1e9)
  broad=mir_eval.transcription.match_notes(ri,rp,ei,ep,onset_tolerance=.2,offset_ratio=None)
  grid=np.arange(0,d['end_seconds'],.01);refpitch=np.zeros(len(grid));estpitch=refpitch.copy()
  for a,b,hz in ref:refpitch[(grid>=a)&(grid<b)]=hz
  for (a,b),hz in zip(ei,ep):estpitch[(grid>=a)&(grid<b)]=hz
  both=(refpitch>0)&(estpitch>0);pitchgood=(np.abs(1200*np.log2(np.maximum(1e-10,estpitch)/np.maximum(1e-10,refpitch)))<=50)&both
  rr[ann]={'reference':len(ri),'estimate':len(ei),'pitch_only_matches':len(pitch_only),'pitch_only_f1':2*len(pitch_only)/(len(ri)+len(ei)),'onset_only_matches':len(onset),'onset_only_f1':2*len(onset)/(len(ri)+len(ei)),
   'pitch_onset200ms_matches':len(broad),'pitch_onset200ms_f1':2*len(broad)/(len(ri)+len(ei)),
   'pitch_agreement_when_both_voiced':float(pitchgood.sum()/max(1,both.sum())),
   'median_est_minus_ref_onset_seconds_matched300ms':float(np.median(errors)) if errors else None,
   'best_diagnostic_delay':max(curve,key=lambda x:x['matches']),'delay_curve':curve,
   'first_reference_notes':ref[:8].tolist(),'first_estimated_notes':np.column_stack([ei,ep])[:8].tolist()}
 rows.append({'id':identifier,'annotators':rr})
agg={}
for ann in ['A1','A2']:
 vals=[r['annotators'][ann] for r in rows];nref=sum(v['reference'] for v in vals);nest=sum(v['estimate'] for v in vals)
 curve=[{'delay':vals[0]['delay_curve'][j]['delay'],'matches':sum(v['delay_curve'][j]['matches'] for v in vals),'micro_f1':2*sum(v['delay_curve'][j]['matches'] for v in vals)/(nref+nest)} for j in range(len(vals[0]['delay_curve']))]
 agg[ann]={'pitch_only_micro_f1':2*sum(v['pitch_only_matches'] for v in vals)/(nref+nest),'onset_only_micro_f1':2*sum(v['onset_only_matches'] for v in vals)/(nref+nest),'pitch_onset200ms_micro_f1':2*sum(v['pitch_onset200ms_matches'] for v in vals)/(nref+nest),'best_global_diagnostic_delay':max(curve,key=lambda x:x['matches']),'pertrack_pitch_agreement_both_voiced':[v['pitch_agreement_when_both_voiced'] for v in vals],'pertrack_best_delay':[v['best_diagnostic_delay'] for v in vals],'global_delay_curve':curve}
report={'diagnostic_only':True,'official_scores_unchanged':True,'delay_range_seconds':[-.3,.3],'delay_step_seconds':.005,'aggregates':agg,'rows':rows}
(root/'data/phase6/rosvot/pilot-diagnostics.json').write_text(json.dumps(report,indent=2))
print(json.dumps({a:{k:v for k,v in d.items() if k!='global_delay_curve'} for a,d in agg.items()},indent=2))

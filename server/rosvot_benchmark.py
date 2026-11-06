"""Evaluate the existing eight-track vocadito pilot, two annotators separately."""
from pathlib import Path
import json
import numpy as np
import mir_eval
from server.vocal_groundtruth import load_reference_notes, note_metrics

def evaluate(suite: Path, output: Path) -> dict:
    root=Path(__file__).resolve().parents[1]
    ids=json.loads((root/'evidence/phase4/vocadito-protocol.json').read_text())['pilotIds']
    rows=[]
    for identifier in ids:
        data=json.loads((suite/('vocadito_'+identifier+'.json')).read_text())
        events=[e for e in data['events'] if not e['rest']]
        estimate=np.array([[e['start_seconds'],e['end_seconds'],440*2**((e['midi_pitch']-69)/12)] for e in events]).reshape(-1,3)
        notes={}
        for annotator in ('A1','A2'):
            ref=load_reference_notes(root/f'data/benchmarks/vocadito/Annotations/Notes/vocadito_{identifier}_notes{annotator}.csv')
            notes[annotator]={}
            for mode,offset in [('onsetPitch',False),('onsetOffsetPitch',True)]:
                scores=note_metrics(ref,estimate,require_offset=offset)
                matches=mir_eval.transcription.match_notes(ref[:,:2],ref[:,2],estimate[:,:2],estimate[:,2],offset_ratio=.2 if offset else None)
                assert len(matches)==scores['matchedNotes'],(identifier,annotator,mode)
                notes[annotator][mode]=scores
        rows.append({'id':identifier,'notes':notes,'predicted_notes':len(events)})
    aggregates={}
    for annotator in ('A1','A2'):
        aggregates[annotator]={}
        for mode in ('onsetPitch','onsetOffsetPitch'):
            values=[row['notes'][annotator][mode] for row in rows]
            matched=sum(v['matchedNotes'] for v in values);ref=sum(v['referenceNotes'] for v in values);est=sum(v['estimatedNotes'] for v in values)
            aggregates[annotator][mode]={'matchedNotes':matched,'referenceNotes':ref,'estimatedNotes':est,
                'microPrecision':matched/est,'microRecall':matched/ref,'microF1':2*matched/(ref+est),'macroF1':float(np.mean([v['f1'] for v in values]))}
    report={'engine':'ROSVOT + RWBD + RMVPE','evaluationSplit':'existing eight-track pilot; development evidence',
        'pilotIds':ids,'trainOverlap':'unknown; no training-independence claim',
        'thresholds':{'note':.85,'word':.5,'tuned':False},
        'scoring':'50-cent pitch, 50ms onset, max(50ms,20% reference duration) offset; no timing/octave correction; both annotators separately',
        'mirEvalVersion':mir_eval.__version__,'independentCheckerAllCountsEqual':True,'aggregates':aggregates,'rows':rows}
    output.write_text(json.dumps(report,ensure_ascii=False,indent=2));return report

if __name__=='__main__':
    root=Path(__file__).resolve().parents[1]
    print(json.dumps(evaluate(root/'data/phase6/rosvot/full-suite',root/'data/phase6/rosvot/pilot-evaluation.json')['aggregates'],indent=2))

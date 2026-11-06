"""Coro isolated ROSVOT runner. Uses official RWBD + ROSVOT, no audio upload.

CLI arguments are those of inference/rosvot.py. Set ROSVOT_DEVICE=cpu|mps.
"""
import os
import sys
import json
import time
import hashlib
import platform
from pathlib import Path
import numpy as np
import torch
from inference.rosvot import RosvotInfer
from utils.audio.pitch_utils import boundary2Interval

torch.set_num_threads(int(os.environ.get('ROSVOT_THREADS', '4')))

class CoroRosvotInfer(RosvotInfer):
    def build_model(self, *args, **kwargs):
        begin = time.perf_counter()
        result = super().build_model(*args, **kwargs)
        self.model_load_seconds = time.perf_counter() - begin
        return result

    def save_result(self, output):
        meta = self.source_items[output['item_name']]
        scale = self.hparams['hop_size'] / self.hparams['audio_sample_rate']
        intervals = boundary2Interval(output['note_bd_pred']) * scale
        pitches = output['note_pred']
        assert len(intervals) == len(pitches)
        offset = meta.get('source_start_seconds', 0.)
        events = [dict(start_seconds=round(float(a),6), end_seconds=round(float(b),6),
                       source_start_seconds=round(float(a+offset),6), source_end_seconds=round(float(b+offset),6),
                       midi_pitch=int(p) if p else None, rest=bool(p==0),
                       boundary_probability=float(output['note_bd_logits'][int(round(a/scale))]) if a > 0 else None)
                  for (a,b),p in zip(intervals,pitches)]
        voiced=[e for e in events if not e['rest']]
        durations=[e['end_seconds']-e['start_seconds'] for e in voiced]
        report = dict(source=meta, model='ROSVOT + learned RWBD + RMVPE pitch embedding',
            backend=os.environ.get('ROSVOT_DEVICE','cpu'),
            method='Official model forward/decode; learned word boundary then learned note boundary and pitch. No F0 run segmentation. No quantization or event merging.',
            thresholds=dict(note=self.args.thr,word=self.args.wbd_thr),
            frame_hop_seconds=scale, inference_elapsed_seconds=time.perf_counter()-self.started,
            model_load_seconds=getattr(self,'model_load_seconds',None),
            events=events, statistics=dict(all_events=len(events),voiced_notes=len(voiced),rest_events=len(events)-len(voiced),
                notes_under_100ms=sum(d<.1 for d in durations),median_note_seconds=float(np.median(durations)) if durations else 0),
            word_boundaries_seconds=(np.flatnonzero(output['word_bd'])*scale).tolist())
        out=Path(self.work_dir);out.mkdir(parents=True,exist_ok=True)
        (out/(output['item_name']+'.intervals.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2))
        np.savez_compressed(out/(output['item_name']+'.raw.npz'),
            note_bd_pred=output['note_bd_pred'],note_pred=pitches,word_bd=output['word_bd'],
            word_durs=output['word_durs'],note_bd_probabilities=output['note_bd_logits'].numpy(),f0=output['f0'])
        return super().save_result(output)

    def run(self):
        self.started=time.perf_counter()
        self.source_items={i['item_name']:i for i in json.loads(Path(self.args.metadata).read_text())} if self.args.metadata else {'output':{'wav_fn':self.args.wav_fn}}
        result=super().run()
        report=dict(success=True,elapsed_seconds=time.perf_counter()-self.started,items=list(result),
            python=sys.version,platform=platform.platform(),torch=torch.__version__,threads=torch.get_num_threads(),
            device=os.environ.get('ROSVOT_DEVICE','cpu'),argv=sys.argv,
            source_commit='3c8332bf43adae35f6e4d64971862f2f6139b310')
        Path(self.work_dir,'run.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
        print(json.dumps(report,ensure_ascii=False))
        return result

if __name__=='__main__':
    CoroRosvotInfer(num_gpus=0).run()

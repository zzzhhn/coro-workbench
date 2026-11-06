"""Subprocess-only ML imports for optional author-pinned MelBand inference."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--audio',required=True)
    parser.add_argument('--output',required=True)
    parser.add_argument('--runtime',required=True)
    parser.add_argument('--device',choices=('auto','cpu','mps'),default='auto')
    args=parser.parse_args()
    import numpy as np
    import soundfile as sf
    import torch
    import yaml
    import librosa
    from ml_collections import ConfigDict
    runtime=Path(args.runtime).resolve()
    sys.path.insert(0,str(runtime/'source'))
    from utils import get_model_from_config,demix_track
    torch.set_num_threads(int(os.environ.get('MELBAND_THREADS','4')))
    source=Path(args.audio).resolve();output=Path(args.output).resolve()
    with source.open('rb') as stream:source_sha=hashlib.file_digest(stream,'sha256').hexdigest()
    audio,sr=sf.read(source,dtype='float32',always_2d=True)
    if not np.isfinite(audio).all():raise ValueError('Source has nonfinite samples')
    channels=audio.shape[1]
    if channels not in (1,2) or not len(audio):raise ValueError('Nonempty mono/stereo input required')
    working=audio.T
    if channels==1:working=np.repeat(working,2,axis=0)
    if sr!=44100:working=librosa.resample(working,orig_sr=sr,target_sr=44100,axis=-1)
    config=ConfigDict(yaml.load((runtime/'source/configs/config_vocals_mel_band_roformer.yaml').read_text(),Loader=yaml.FullLoader))
    selected='mps' if args.device=='auto' and torch.backends.mps.is_available() else ('cpu' if args.device=='auto' else args.device)
    if selected=='mps' and not torch.backends.mps.is_available():raise RuntimeError('Requested MPS is unavailable')
    started=time.monotonic();fallback=None
    def run(device):
        model=get_model_from_config('mel_band_roformer',config)
        state=torch.load(runtime/'MelBandRoformer.ckpt',map_location='cpu',weights_only=True)
        model.load_state_dict(state,strict=True)
        del state
        model=model.eval().to(device)
        result,_=demix_track(config,model,torch.from_numpy(np.ascontiguousarray(working)),device)
        if device=='mps':torch.mps.synchronize()
        return result['vocals']
    try:
        vocals=run(selected)
    except (RuntimeError,NotImplementedError) as error:
        if args.device!='auto' or selected!='mps':raise
        fallback=f'{type(error).__name__}: {error}'
        print('MPS failed; retrying on CPU: '+fallback,flush=True)
        selected='cpu'
    if fallback is not None:
        import gc
        gc.collect();torch.mps.empty_cache()
        vocals=run(selected)
    if sr!=44100:vocals=librosa.resample(vocals,orig_sr=44100,target_sr=sr,axis=-1)
    vocals=librosa.util.fix_length(vocals,size=len(audio),axis=-1)
    vocals=vocals.T if channels==2 else vocals.mean(axis=0)[:,None]
    if not np.isfinite(vocals).all():raise RuntimeError('Nonfinite model output')
    output.mkdir(parents=True,exist_ok=True)
    sf.write(output/'vocals.wav',vocals,sr,subtype='FLOAT')
    sf.write(output/'instrumental.wav',audio-vocals,sr,subtype='FLOAT')
    report={'engine':'Mel-Band-RoFormer Kimberley Jensen','target':'full vocals (may include backing)',
            'input':{'path':str(source),'sha256':source_sha,'sampleRate':sr,'channels':channels,'frames':len(audio),'sourceStartSeconds':0.,'sourceEndSeconds':len(audio)/sr},
            'output':{'sampleRate':sr,'channels':channels,'frames':len(vocals),'subtype':'FLOAT','vocalsSha256':hashlib.sha256((output/'vocals.wav').read_bytes()).hexdigest(),'instrumentalSha256':hashlib.sha256((output/'instrumental.wav').read_bytes()).hexdigest()},
            'device':selected,'requestedDevice':args.device,'fallbackReason':fallback,'torch':torch.__version__,
            'modelRuntimeSeconds':round(time.monotonic()-started,4),'modelSampleRate':44100,
            'chunkSamples':int(config.inference.chunk_size),'overlap':int(config.inference.num_overlap),
            'vocalsPeak':float(abs(vocals).max()),'vocalsRms':float(np.sqrt(np.mean(vocals**2))),
            'resampled':sr!=44100,'normalization':'none; float peaks above1 retained',
            'requiresReview':True,'limitations':'Full vocals are not guaranteed lead vocals. Residual reconstruction is arithmetic, not separation accuracy. Resampling preserves sample count/time, not sample identity.'}
    (output/'separation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(report),flush=True)


if __name__=='__main__':main()

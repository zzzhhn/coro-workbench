"""Local SOFA Mandarin alignment adapter over text and audio only.

Uses the official frozen network, mel extractor and forced decoder. Training
dependencies are not loaded. No score, MIDI or reference note timings accepted.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
SOFA_COMMIT = '9549c6a86d16019c817eefe4bb8183405da524cc'


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1048576), b''):
            h.update(block)
    return h.hexdigest()


def align(audio: Path, segments: list[dict], model: Path, output: Path):
    import numpy as np
    import numba
    import torch
    import yaml
    from pypinyin import lazy_pinyin

    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    source = ROOT / 'models/sofa-source'
    revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    if revision != SOFA_COMMIT:
        raise ValueError('SOFA source revision changed; revalidate adapter before use')
    sys.path.insert(0, str(source))
    from modules.layer.backbone.unet import UNetBackbone
    from modules.layer.block.resnet_block import ResidualBasicBlock
    from modules.layer.scaling.stride_conv import DownSampling, UpSampling
    spec = importlib.util.spec_from_file_location('coro_sofa_mel', source / 'modules/rmvpe/spec.py')
    mel_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mel_module)

    # Reuse only the two pure official decoder functions; avoid importing the
    # ONNX CLI, AP detector or unrelated training framework.
    tree = ast.parse((source / 'onnx_infer.py').read_text())
    functions = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ('forward_pass', 'decode')]
    assert len(functions) == 2
    namespace = {'np': np, 'numba': numba}
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(source / 'onnx_infer.py'), 'exec'), namespace)

    checkpoint = torch.load(model, map_location='cpu', weights_only=True)
    hp = checkpoint['hyper_parameters']
    vocab = yaml.safe_load(hp['vocab_text'])
    mc, sc = hp['model_config'], hp['melspec_config']
    backbone = UNetBackbone(sc['n_mels'], mc['hidden_dims'], mc['hidden_dims'], ResidualBasicBlock,
        DownSampling, UpSampling, down_sampling_factor=mc['down_sampling_factor'],
        down_sampling_times=mc['down_sampling_times'], channels_scaleup_factor=mc['channels_scaleup_factor'])
    head = torch.nn.Linear(mc['hidden_dims'], vocab['<vocab_size>'] + 2)
    state = checkpoint['state_dict']
    backbone.load_state_dict({k.removeprefix('backbone.'): v for k, v in state.items() if k.startswith('backbone.')}, strict=True)
    head.load_state_dict({k.removeprefix('head.'): v for k, v in state.items() if k.startswith('head.')}, strict=True)
    del checkpoint, state
    backbone.eval(); head.eval()
    mel = mel_module.MelSpectrogram(sc['n_mels'], sc['sample_rate'], sc['win_length'], sc['hop_length'],
        sc['n_fft'], sc['fmin'], sc['fmax'], sc['clamp'])
    dictionary_path = source / 'dictionary/opencpop-extension.txt'
    dictionary = dict(line.split('\t', 1) for line in dictionary_path.read_text().strip().splitlines())
    output.mkdir(parents=True, exist_ok=True)
    result = {'engine': 'SOFA Mandarin v1.0.0', 'sourceCommit': revision, 'checkpointSha256': sha(model),
              'audioSha256': sha(audio), 'dictionarySha256': sha(dictionary_path),
              'inputKind': 'audio and plain lyrics only', 'referenceNotesUsed': False,
              'confidenceKind': 'uncalibrated acoustic alignment posterior', 'segments': []}
    for item in segments:
        begin = time.monotonic()
        start, end = float(item['start']), float(item['end'])
        text = item['text']
        if not 0 <= start < end or not text or any(not '\u4e00' <= c <= '\u9fff' for c in text):
            raise ValueError('Use explicit ordered Mandarin characters and valid audio bounds')
        syllables = lazy_pinyin(text, neutral_tone_with_five=False, errors='exception')
        if len(syllables) != len(text):
            raise ValueError('One Mandarin syllable per input character required')
        phones, owners = ['SP'], [-1]
        for i, syllable in enumerate(syllables):
            if syllable not in dictionary:
                raise ValueError(f'Missing dictionary syllable: {syllable}')
            ps = dictionary[syllable].split()
            phones.extend(ps + ['SP']); owners.extend([i] * len(ps) + [-1])
        ids = np.asarray([vocab[p] for p in phones], np.int64)
        pcm = subprocess.check_output(['ffmpeg', '-v', 'error', '-nostdin', '-ss', str(start), '-t', str(end-start),
            '-i', str(audio), '-f', 'f32le', '-ac', '1', '-ar', str(sc['sample_rate']), '-'])
        waveform = torch.from_numpy(np.frombuffer(pcm, dtype='<f4').copy())[None]
        length = waveform.shape[1] / sc['sample_rate']
        with torch.inference_mode():
            features = mel(waveform)
            features = (features-features.mean())/features.std()
            features = features.repeat_interleave(sc['scale_factor'], dim=2)
            logits = head(backbone(features.transpose(1, 2)))
            count = int((length*sc['scale_factor']*sc['sample_rate']+.5)/sc['hop_length'])
            logits = logits[0, :count]
            mask = torch.full((vocab['<vocab_size>'],), -1e9)
            mask[ids] = 0; mask[0] = 0
            logp = torch.log_softmax(logits[:, 2:].float()+mask, dim=-1).numpy()
            edges = ((torch.sigmoid(logits[:, 0])-.1)/.8).clamp(0, 1).numpy()
        edge_diff = np.r_[np.diff(edges), 0]
        edge_prob = np.clip(edges+np.r_[0, edges[:-1]], 0, 1)
        indices, frames, frame_confidence = namespace['decode'](ids, logp, edge_prob)
        hop = sc['hop_length']/(sc['sample_rate']*sc['scale_factor'])
        times = np.r_[frames+np.clip(edge_diff[frames]/2, -.5, .5), len(logp)]*hop
        aligned = []
        for j, index in enumerate(indices):
            lo, hi = int(frames[j]), int(frames[j+1]) if j+1<len(frames) else len(logp)
            aligned.append({'phone': phones[index], 'wordIndex': owners[index],
                'start': max(start, start+float(times[j])), 'end': min(end, start+float(times[j+1])),
                'posterior': float(np.exp(logp[lo:hi, ids[index]].mean())) if hi>lo else 0.})
        words = []
        for i, (char, syllable) in enumerate(zip(text, syllables)):
            ps = [p for p in aligned if p['wordIndex']==i]
            if not ps:
                raise ValueError(f'SOFA skipped text index {i}; do not silently publish partial lyrics')
            words.append({'id': f"{item['id']}-{i}", 'text': char, 'pinyin': syllable,
                'start': ps[0]['start'], 'end': ps[-1]['end'], 'vowelStart': ps[-1]['start'],
                'posterior': float(np.mean([p['posterior'] for p in ps])), 'phones': ps})
        row = {**item, 'words': words, 'phones': aligned,
            'confidence': float(np.exp(np.mean(np.log(frame_confidence+1e-6))/3)),
            'elapsedSeconds': time.monotonic()-begin}
        result['segments'].append(row)
        np.savez_compressed(output/f"{item['id']}-evidence.npz", logp=logp, edge=edges,
            phone_ids=ids, path_indices=indices, path_frames=frames, hop=hop, start=start)
        (output/'alignment.json').write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
        print(json.dumps({'segment':item['id'],'words':len(words),'confidence':row['confidence'],
                          'seconds':round(row['elapsedSeconds'],1)},ensure_ascii=False),flush=True)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--audio', type=Path, required=True)
    parser.add_argument('--segments', type=Path, required=True)
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    align(args.audio, json.loads(args.segments.read_text()), args.model, args.output)

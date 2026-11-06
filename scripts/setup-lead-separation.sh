#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
.venv/bin/python - <<'PY'
from pathlib import Path
import json, hashlib, urllib.request
root = Path('models/lead-separation'); root.mkdir(parents=True, exist_ok=True)
sha = 'f90e997ad60af6bf25bac77ad02f5e127a564d363a2b60ecb41100cd83e4ba12'
revision = '9e1bce0c9908b395ad59137c2c420501aaed11ed'
url = f'https://huggingface.co/musetric/uvr-mdxnet-kara2-onnx/resolve/{revision}/kara2.onnx'
path = root / 'kara2.onnx'
if not path.exists():
    print('Downloading53MB public MIT KARA2 lead/backing model. No user audio leaves the machine.')
    tmp = path.with_suffix('.partial')
    urllib.request.urlretrieve(url, tmp)
    if hashlib.sha256(tmp.read_bytes()).hexdigest() != sha: raise RuntimeError('Downloaded KARA2 checksum mismatch')
    tmp.replace(path)
if hashlib.sha256(path.read_bytes()).hexdigest() != sha: raise RuntimeError('Existing KARA2 checksum mismatch; not overwritten')
model_card = f'https://huggingface.co/musetric/uvr-mdxnet-kara2-onnx/raw/{revision}/README.md'
with urllib.request.urlopen(model_card) as response: (root/'MODEL_CARD.md').write_bytes(response.read())
(root/'manifest.json').write_text(json.dumps({'source':url,'revision':revision,'sha256':sha,'license':'MIT (UVR upstream weights; musetric ONNX conversion)','authors':'UVR Anjok07/aufr33; ONNX repack musetric','trainingDataProvenance':'not documented upstream','purpose':'isolated-vocal lead/backing hypotheses, not ground-truth singer identity'},indent=2)+'\n')
print('KARA2 installed. New quality-auto analyses will preserve raw vocals and lead/backing branches.')
PY

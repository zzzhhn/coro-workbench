#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Install isolated local audio-quality models (no cloud inference)."
echo "BeatThis/FCPE code and bundled models: MIT. Piano package: MIT classifier; piano checkpoint: CC BY 4.0, Zenodo 4034264."
if [ ! -x models/audio-quality/.venv/bin/python ]; then
  uv venv --python 3.11 models/audio-quality/.venv
fi
uv pip install --python models/audio-quality/.venv/bin/python \
  torch==2.5.1 torchaudio==2.5.1 numpy==1.26.4 scipy==1.14.1 \
  librosa==0.10.2.post1 soundfile==0.13.1 \
  'torchfcpe==0.0.4' 'torchcrepe==0.0.24' 'beat-this==1.0' \
  'piano-transcription-inference==0.0.6' 'torchlibrosa==0.1.0'

models/audio-quality/.venv/bin/python - <<'PY'
from pathlib import Path
import hashlib, json, urllib.request
root = Path('models/audio-quality')
models = [
    ('beat-this-final0.ckpt', 'https://cloud.cp.jku.at/index.php/s/7ik4RrBKTS273gp/download?path=%2F&files=final0.ckpt', '8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331', 'MIT'),
    ('piano-regression.pth', 'https://zenodo.org/records/4034264/files/CRNN_note_F1%3D0.9677_pedal_F1%3D0.9186.pth?download=1', 'c3fa9730725bf4a762f1c14bc80cd5986eacda01b026f5a4a2525cd607876141', 'CC-BY-4.0'),
]
def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as handle:
        while block := handle.read(1024*1024): value.update(block)
    return value.hexdigest()
for name, url, expected, license_name in models:
    path = root / name
    if not path.exists():
        print('Downloading public model:', name, flush=True)
        temp = path.with_suffix('.partial')
        urllib.request.urlretrieve(url, temp)
        if digest(temp) != expected: raise RuntimeError('Downloaded checksum mismatch: ' + name)
        temp.replace(path)
    if digest(path) != expected: raise RuntimeError('Existing model mismatch; not overwritten: ' + name)
(root / 'manifest.json').write_text(json.dumps({'models': [{'file': n, 'url': u, 'sha256': h, 'license': l} for n,u,h,l in models]}, indent=2) + '\n')
print('Models verified. New analyses can return reversible score proposals; old projects stay untouched.')
PY

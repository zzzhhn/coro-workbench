#!/usr/bin/env bash
set -euo pipefail
TASK_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$TASK_ROOT"
RUNTIME="$TASK_ROOT/models/rosvot"
mkdir -p "$RUNTIME"
if [ ! -x "$RUNTIME/.venv/bin/python" ]; then
  uv venv --python 3.11 "$RUNTIME/.venv"
fi
uv pip install --python "$RUNTIME/.venv/bin/python" -r scripts/setup-rosvot.requirements.txt
if [ ! -f "$RUNTIME/source/inference/rosvot.py" ]; then
  git clone https://github.com/RickyL-2000/ROSVOT.git "$RUNTIME/source"
  git -C "$RUNTIME/source" checkout 3c8332bf43adae35f6e4d64971862f2f6139b310
fi
if [ ! -f "$RUNTIME/checkpoints/rosvot/model.pt" ]; then
  "$RUNTIME/.venv/bin/gdown" 'https://drive.google.com/uc?id=1JNtNT37KiLq9uFQqHk7JFs-3trxd3bRh' -O "$RUNTIME/checkpoints.zip"
  "$RUNTIME/.venv/bin/python" - "$RUNTIME" <<'PY'
import sys,hashlib,zipfile
from pathlib import Path
root=Path(sys.argv[1]);archive=root/'checkpoints.zip'
expected='b6055e81315b93415c9bd7fc48e10a28a3da1bea960cab7385483bd7443ba852'
if hashlib.sha256(archive.read_bytes()).hexdigest()!=expected:raise SystemExit('Official checkpoint archive hash changed; review new weights before use')
with zipfile.ZipFile(archive) as package:package.extractall(root)
PY
fi
"$RUNTIME/.venv/bin/python" - "$TASK_ROOT" <<'PY'
from pathlib import Path
import sys,json,yaml
root=Path(sys.argv[1]);runtime=root/'models/rosvot';source=runtime/'source'
import subprocess
patch=root/'scripts/setup-rosvot.patch'
check=subprocess.run(['git','apply','--check',str(patch)],cwd=source,capture_output=True,text=True)
if check.returncode == 0:
 subprocess.run(['git','apply',str(patch)],cwd=source,check=True)
else:
 reverse=subprocess.run(['git','apply','--check','--reverse',str(patch)],cwd=source,capture_output=True,text=True)
 if reverse.returncode != 0:raise SystemExit('ROSVOT source differs from pinned patch; review before replacing local edits')
for model in ['rosvot','rwbd']:
 p=runtime/f'checkpoints/{model}/config.yaml'
 original=p.with_name('config.upstream.yaml')
 if not original.exists():original.write_text(p.read_text())
 d=yaml.safe_load(p.read_text());d['pe_ckpt']=str(runtime/'checkpoints/rmvpe/model.pt');p.write_text(yaml.safe_dump(d,allow_unicode=True,sort_keys=False))
entries={
 'rosvot':(144674420,'7501fb5f913d971c2f51bcb3063b930027b03206581820a4d2bfdc394c9c3fcb'),
 'rwbd':(119897457,'0bc2d42a6d4b7a05436deb937e2deda1c12de49e5687cfda0bdf6a430120dcd2'),
 'rmvpe':(368492925,'19dc1809cf4cdb0a18db93441816bc327e14e5644b72eeaae5220560c6736fe2')}
manifest={f'models/rosvot/checkpoints/{model}/model.pt':{'bytes':size,'sha256':sha} for model,(size,sha) in entries.items()}
(runtime/'weights-manifest.json').write_text(json.dumps(manifest,indent=2))
sys.path.insert(0,str(root));from server.rosvot import runtime_health
health=runtime_health();print(json.dumps(health,indent=2))
if not health['ready']:raise SystemExit('ROSVOT setup verification failed')
PY

#!/usr/bin/env bash
set -euo pipefail
TASK_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$TASK_ROOT"
RUNTIME="$TASK_ROOT/models/melband-roformer"
mkdir -p "$RUNTIME"
if [ ! -x "$RUNTIME/.venv/bin/python" ]; then
  uv venv --python 3.11 "$RUNTIME/.venv"
fi
uv pip install --python "$RUNTIME/.venv/bin/python" -r scripts/setup-melband.requirements.txt
if [ ! -f "$RUNTIME/source/inference.py" ]; then
  git clone https://github.com/KimberleyJensen/Mel-Band-Roformer-Vocal-Model.git "$RUNTIME/source"
  git -C "$RUNTIME/source" checkout 25f44ffb55ee3c301281bba21b2d6d311cb69ae2
fi
if [ "$(git -C "$RUNTIME/source" rev-parse HEAD)" != '25f44ffb55ee3c301281bba21b2d6d311cb69ae2' ]; then
  echo 'MelBand source revision differs; review local checkout first' >&2
  exit 1
fi
if git -C "$RUNTIME/source" apply --check "$TASK_ROOT/scripts/setup-melband.patch" 2>/dev/null; then
  git -C "$RUNTIME/source" apply "$TASK_ROOT/scripts/setup-melband.patch"
else
  git -C "$RUNTIME/source" apply --check --reverse "$TASK_ROOT/scripts/setup-melband.patch"
fi
if [ ! -f "$RUNTIME/MelBandRoformer.ckpt" ]; then
  curl -L --fail --retry 2 'https://huggingface.co/KimberleyJSN/melbandroformer/resolve/ac9b0614ab3cd7f77219e18ba494dfd93956c348/MelBandRoformer.ckpt' -o "$RUNTIME/MelBandRoformer.ckpt.download"
  "$RUNTIME/.venv/bin/python" - "$RUNTIME/MelBandRoformer.ckpt.download" <<'PY'
import hashlib, sys
from pathlib import Path
path = Path(sys.argv[1])
with path.open('rb') as source:
    digest = hashlib.file_digest(source, 'sha256').hexdigest()
if path.stat().st_size != 913106900 or digest != '87201f4d31afb5bc79993230fc49446918425574db48c01c405e44f365c7559e':
    raise SystemExit('Downloaded MelBand checkpoint differs from the pinned author artifact; not installed')
PY
  mv "$RUNTIME/MelBandRoformer.ckpt.download" "$RUNTIME/MelBandRoformer.ckpt"
fi
"$RUNTIME/.venv/bin/python" - "$TASK_ROOT" <<'PY'
import json,sys
from pathlib import Path
root=Path(sys.argv[1]);sys.path.insert(0,str(root))
from server.melband import runtime_health
health=runtime_health();print(json.dumps(health,indent=2))
if not health['ready']:raise SystemExit('Pinned MelBand verification failed')
PY

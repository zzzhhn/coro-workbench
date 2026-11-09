#!/usr/bin/env bash
set -euo pipefail
TASK_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME="$TASK_ROOT/models/phoneme-ast"
COMMIT=b2fcd9ea0f7898a8989c7e65781052d1ffc81094
SHA=e56d1c7438f10afb61bbfe54a856a0355d4556fca6038dc67567fe68930ade17
BYTES=106129108
SOURCE_URL=https://github.com/seyong92/phoneme-informed-note-level-singing-transcription.git
MODEL_URL=https://github.com/seyong92/phoneme-informed-note-level-singing-transcription/releases/download/0.1.0/model.pt
cd "$TASK_ROOT"
command -v uv >/dev/null || { echo 'Install uv before running optional phoneme setup.' >&2; exit 1; }
mkdir -p "$RUNTIME"

verify_source() {
  [ -d "$RUNTIME/source/.git" ] || { echo 'Existing phoneme source is not a Git checkout; preserved.' >&2; return 1; }
  [ "$(git -C "$RUNTIME/source" rev-parse HEAD)" = "$COMMIT" ] || { echo 'Existing phoneme source commit differs; preserved.' >&2; return 1; }
  [ -z "$(git -C "$RUNTIME/source" status --porcelain --untracked-files=normal)" ] || { echo 'Existing phoneme source has local work; preserved.' >&2; return 1; }
}
verify_model() {
  /usr/bin/python3 - "$RUNTIME/model.pt" "$SHA" "$BYTES" <<'PY'
import hashlib, sys
from pathlib import Path
path=Path(sys.argv[1]); digest=hashlib.sha256()
with path.open('rb') as stream:
    for block in iter(lambda: stream.read(1024*1024), b''): digest.update(block)
if path.stat().st_size != int(sys.argv[3]) or digest.hexdigest() != sys.argv[2]:
    raise SystemExit('Existing phoneme checkpoint differs from pinned release; preserved.')
PY
}

# Inspect existing assets before installing or mutating any runtime files.
if [ -e "$RUNTIME/source" ] || [ -L "$RUNTIME/source" ]; then verify_source; fi
if [ -e "$RUNTIME/model.pt" ] || [ -L "$RUNTIME/model.pt" ]; then verify_model; fi
if [ -L "$RUNTIME/.venv" ]; then
  echo 'Existing phoneme .venv is a symlink; preserved without modifying its target.' >&2; exit 1
fi
STAGING="$(mktemp -d "$RUNTIME/.setup-XXXXXX")"
trap 'rm -rf "$STAGING"' EXIT
if [ ! -d "$RUNTIME/source" ]; then
  GIT_LFS_SKIP_SMUDGE=1 git clone --no-checkout "$SOURCE_URL" "$STAGING/source"
  GIT_LFS_SKIP_SMUDGE=1 git -C "$STAGING/source" checkout --detach "$COMMIT"
  mv "$STAGING/source" "$RUNTIME/source"
fi
verify_source
if [ ! -f "$RUNTIME/model.pt" ]; then
  curl --fail --location --retry 3 --output "$STAGING/model.pt" "$MODEL_URL"
  /usr/bin/python3 - "$STAGING/model.pt" "$SHA" "$BYTES" <<'PY'
import hashlib, sys
from pathlib import Path
path=Path(sys.argv[1]); digest=hashlib.sha256()
with path.open('rb') as stream:
    for block in iter(lambda: stream.read(1024*1024), b''): digest.update(block)
if path.stat().st_size != int(sys.argv[3]) or digest.hexdigest() != sys.argv[2]:
    raise SystemExit('Downloaded official phoneme checkpoint failed pinned integrity check.')
PY
  # Refuse a race with another setup/user writer, rather than replacing it.
  ln "$STAGING/model.pt" "$RUNTIME/model.pt"
fi
verify_model
if [ -e "$RUNTIME/.venv" ] && [ ! -x "$RUNTIME/.venv/bin/python" ]; then
  echo 'Existing phoneme .venv is incomplete; preserved. Move it explicitly before retrying.' >&2; exit 1
fi
if [ ! -x "$RUNTIME/.venv/bin/python" ]; then uv venv --python 3.11 "$RUNTIME/.venv"; fi
"$RUNTIME/.venv/bin/python" -c 'import sys; assert sys.version_info[:2] == (3, 11), "Phoneme runtime requires Python 3.11; existing environment preserved"'
if [ "$(uname -s)" = Darwin ]; then
  uv pip install --python "$RUNTIME/.venv/bin/python" torch==2.5.1 torchaudio==2.5.1
else
  uv pip install --python "$RUNTIME/.venv/bin/python" --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple 'torch==2.5.1+cpu' 'torchaudio==2.5.1+cpu'
fi
uv pip install --python "$RUNTIME/.venv/bin/python" -r "$TASK_ROOT/scripts/setup-phoneme.requirements.txt"
"$RUNTIME/.venv/bin/python" - "$TASK_ROOT" <<'PY'
import hashlib, importlib.metadata, json, sys
from pathlib import Path
root=Path(sys.argv[1]); runtime=root/'models/phoneme-ast'
sys.path.insert(0,str(root))
from server.phoneme import SOURCE_COMMIT, MODEL_SHA256, runtime_health
manifest={'sourceCommit':SOURCE_COMMIT,'checkpointSha256':MODEL_SHA256,
          'requirementsSha256':hashlib.sha256((root/'scripts/setup-phoneme.requirements.txt').read_bytes()).hexdigest(),
          'python':sys.version.split()[0], 'versions':{name:importlib.metadata.version(name) for name in
          ('torch','torchaudio','nnAudio','wquantiles','librosa','numpy','scipy','soundfile')}}
(runtime/'runtime-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
health=runtime_health(); print(json.dumps(health,indent=2))
if not health['ready']:raise SystemExit('Phoneme setup verification failed')
PY

#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v uv >/dev/null 2>&1; then
  echo "Please install uv (https://docs.astral.sh/uv/) and rerun this script."
  exit 1
fi

if [ ! -x .venv/bin/python ]; then
  uv venv --python 3.11 .venv
fi

if [ "${1:-}" != "--models" ]; then
  uv pip install --python .venv/bin/python -r requirements-audio.txt
  uv pip install --python .venv/bin/python --no-deps basic-pitch==0.4.0
fi

.venv/bin/python -m server.download_models
.venv/bin/python - <<'PY'
import json
from server.config import engine_health
print(json.dumps(engine_health(), indent=2))
if not engine_health()['ffmpeg']['ready']:
    raise SystemExit('Install FFmpeg (for example: brew install ffmpeg) before importing audio.')
PY

echo "Ready. Start the local backend: .venv/bin/python -m uvicorn server.app:app --host 127.0.0.1 --port 8765"

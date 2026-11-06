#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v uv >/dev/null 2>&1; then
  echo "Install uv first: https://docs.astral.sh/uv/"
  exit 1
fi
if [ ! -x .venv/bin/python ]; then
  echo "Run ./scripts/setup-audio.sh first to prepare Coro's shared Python API runtime."
  exit 1
fi
uv pip install --python .venv/bin/python -r requirements-omr.txt
.venv/bin/python -m server.install_omr
.venv/bin/python - <<'PY'
import json
from server.omr import omr_health
health = omr_health()
print(json.dumps(health, ensure_ascii=False, indent=2))
if not health['ready']:
    raise SystemExit('OMR needs pdftoppm (Poppler) plus the pinned local runtime. Install Poppler if missing.')
PY

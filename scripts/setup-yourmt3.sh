#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -x .venv/bin/python ]; then
  echo "Run ./scripts/setup-audio.sh first."
  exit 1
fi

echo "Optional local research installation: YourMT3+"
echo "Downloads public source and 562MB weights, plus an isolated Python runtime."
echo "HF files/weights declare Apache-2.0; upstream GitHub root declares GPLv3."
echo "Do not redistribute commercially until component-level licensing is reviewed."

.venv/bin/python -m server.install_yourmt3
if [ ! -x models/yourmt3/.venv/bin/python ]; then
  uv venv --python 3.11 models/yourmt3/.venv
fi
uv pip install --python models/yourmt3/.venv/bin/python -r requirements-yourmt3.txt
.venv/bin/python - <<'PY'
from server.config import engine_health
print('YourMT3+ installed:', engine_health()['yourMT3']['ready'])
PY

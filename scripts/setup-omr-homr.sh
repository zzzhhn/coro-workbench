#!/usr/bin/env bash
# Optional second OMR engine (homr, AGPL-3.0) in its own venv under models/omr/homr.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -x .venv/bin/python ]; then
  echo "Run ./scripts/setup-audio.sh first to prepare Coro's shared Python API runtime."
  exit 1
fi
.venv/bin/python -m server.install_omr_homr
.venv/bin/python -c "import json; from server.omr import omr_health; print(json.dumps(omr_health(), ensure_ascii=False, indent=2))"

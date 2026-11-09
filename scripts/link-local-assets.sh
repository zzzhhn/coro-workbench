#!/usr/bin/env bash
# Link the main checkout's local runtimes and private assets into a parallel
# worktree. Nothing is copied, moved or deleted. Each worktree keeps its own
# data/ directory, so its backend never recovers or fails another checkout's jobs.
# Usage: scripts/link-local-assets.sh /path/to/main/checkout
set -euo pipefail
main="${1:?usage: scripts/link-local-assets.sh /path/to/main/checkout}"
main="$(cd "$main" && pwd -P)"
here="$(cd "$(dirname "$0")/.." && pwd -P)"
[ "$main" = "$here" ] && { echo "Run this inside the worktree, not the main checkout." >&2; exit 1; }
for name in .venv node_modules models evidence work audio reference; do
  if [ -e "$here/$name" ] || [ -L "$here/$name" ]; then
    echo "keep   $name (already present)"
  elif [ -e "$main/$name" ]; then
    ln -s "$main/$name" "$here/$name" && echo "linked $name"
  else
    echo "skip   $name (absent in main checkout)"
  fi
done
mkdir -p "$here/data" && chmod 700 "$here/data"
if [ -d "$main/data/notation-phase2-baseline" ] && [ ! -e "$here/data/notation-phase2-baseline" ]; then
  ln -s "$main/data/notation-phase2-baseline" "$here/data/notation-phase2-baseline" && echo "linked data/notation-phase2-baseline"
fi
echo "Main checkout jobs stay readable at $main/data/<job-id>; do not write there."
echo "Do not pip install into the shared .venv; create a separate venv for new tools."
echo "Scripts stored under linked evidence/ or work/ resolve to the main checkout via"
echo "Path(__file__).resolve(). Use Path.cwd() as ROOT so they import this worktree's server/."

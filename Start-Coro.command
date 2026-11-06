#!/bin/zsh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.12 or newer is required. Install Node.js, then reopen this launcher."
  read -r "?Press Enter to close."
  exit 1
fi
npm start

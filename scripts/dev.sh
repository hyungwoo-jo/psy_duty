#!/usr/bin/env bash
set -euo pipefail
PORT=${1:-5174}
PREFIX=${2:-/psy_duty/}
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Kill if occupied
if command -v lsof >/dev/null 2>&1; then
  PIDS=$(lsof -iTCP:${PORT} -sTCP:LISTEN -t || true)
  if [ -n "$PIDS" ]; then echo "Killing PID(s) on :$PORT -> $PIDS"; kill -9 $PIDS || true; fi
fi
python3 "$ROOT/serve/serve.py" --root "$ROOT" --port "$PORT" --prefix "$PREFIX" --open

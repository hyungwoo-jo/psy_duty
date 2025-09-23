#!/usr/bin/env bash
set -euo pipefail

# Release per-person ICS files to a versioned GitHub Pages path.
#
# Usage:
#   scripts/release_ics.sh --month 2025-10 --version v3 --json path/to/duty-roster.json [--set-latest]
#
# Resulting URLs:
#   public/ics/2025-10/v3/<이름>.ics  ->  https://<OWNER>.github.io/psy_duty/ics/2025-10/v3/<이름>.ics
#
# Notes:
# - Does NOT overwrite existing version unless forced (not implemented; create a new version instead).
# - Optionally updates public/ics/<month>/index.html to redirect to chosen version when --set-latest is used.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MONTH=""
VERSION=""
JSON=""
SET_LATEST=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --month) MONTH="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --json) JSON="$2"; shift 2 ;;
    --set-latest) SET_LATEST=true; shift ;;
    *) echo "Unknown arg: $1"; exit 2 ;;
  esac
done

if [[ -z "$MONTH" || -z "$VERSION" || -z "$JSON" ]]; then
  echo "Usage: $0 --month YYYY-MM --version vN --json path/to/duty-roster.json [--set-latest]" >&2
  exit 2
fi

OUT_DIR="public/ics/${MONTH}/${VERSION}"
if [[ -d "$OUT_DIR" ]]; then
  echo "Error: target already exists: $OUT_DIR" >&2
  echo "Create a new --version (e.g., v4) to avoid overwriting." >&2
  exit 3
fi

mkdir -p "$OUT_DIR"

echo "Building per-person ICS to $OUT_DIR ..."
python3 scripts/build_ics.py "$JSON" -o "$OUT_DIR"

if $SET_LATEST; then
  echo "Updating index redirect for ${MONTH} -> ${VERSION} ..."
  MONTH_DIR="public/ics/${MONTH}"
  mkdir -p "$MONTH_DIR"
  cat >"$MONTH_DIR/index.html" <<HTML
<!doctype html>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=./${VERSION}/">
<title>${MONTH} ICS redirect</title>
<p>Redirecting to ${VERSION} … <a href="./${VERSION}/">click here</a></p>
HTML
fi

echo "Preparing commit..."
git add -A public/ics
MSG="release(ics): ${MONTH} ${VERSION}"
git commit -m "$MSG" || true

echo "Pushing to origin main..."
CUR=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
if [[ "$CUR" != "main" && -n "$CUR" ]]; then
  echo "Currently on $CUR. Please switch to main manually or adjust the script." >&2
  exit 4
fi
git push origin main

OWNER=$(gh api user --jq .login 2>/dev/null || echo "<OWNER>")
BASE="https://${OWNER}.github.io/psy_duty/ics/${MONTH}/${VERSION}/"
echo "Done. Host path: $BASE"
echo "Use this as 'ICS 링크 기본 경로' in the app before exporting Excel."


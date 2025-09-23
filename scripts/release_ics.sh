#!/usr/bin/env bash
set -euo pipefail

# Release per-person ICS files to a versioned GitHub Pages path.
#
# Usage (one of --json, --ics-dir, --ics-zip):
#   scripts/release_ics.sh --month 2025-10 --version v3 --json path/to/duty-roster.json [--set-latest]
#   scripts/release_ics.sh --month 2025-10 --version v3 --ics-dir path/to/ics_files [--set-latest]
#   scripts/release_ics.sh --month 2025-10 --version v3 --ics-zip path/to/duty-roster-ics.zip [--set-latest]
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
ICS_DIR=""
ICS_ZIP=""
SET_LATEST=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --month) MONTH="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --json) JSON="$2"; shift 2 ;;
    --ics-dir) ICS_DIR="$2"; shift 2 ;;
    --ics-zip) ICS_ZIP="$2"; shift 2 ;;
    --set-latest) SET_LATEST=true; shift ;;
    *) echo "Unknown arg: $1"; exit 2 ;;
  esac
done

if [[ -z "$MONTH" || -z "$VERSION" ]]; then
  echo "Usage: $0 --month YYYY-MM --version vN (--json roster.json | --ics-dir DIR | --ics-zip ZIP) [--set-latest]" >&2
  exit 2
fi

OUT_DIR="public/ics/${MONTH}/${VERSION}"
if [[ -d "$OUT_DIR" ]]; then
  echo "Error: target already exists: $OUT_DIR" >&2
  echo "Create a new --version (e.g., v4) to avoid overwriting." >&2
  exit 3
fi

mkdir -p "$OUT_DIR"

if [[ -n "$JSON" ]]; then
  echo "Building per-person ICS from JSON to $OUT_DIR ..."
  python3 scripts/build_ics.py "$JSON" -o "$OUT_DIR"
elif [[ -n "$ICS_DIR" ]]; then
  echo "Copying ICS files from $ICS_DIR to $OUT_DIR ..."
  shopt -s nullglob
  for f in "$ICS_DIR"/*.ics; do cp -f "$f" "$OUT_DIR/"; done
  shopt -u nullglob
elif [[ -n "$ICS_ZIP" ]]; then
  echo "Unzipping $ICS_ZIP to $OUT_DIR ..."
  unzip -o "$ICS_ZIP" -d "$OUT_DIR" >/dev/null
else
  echo "Error: one of --json / --ics-dir / --ics-zip is required" >&2
  exit 2
fi

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

# Build index.html for the version folder with per-person links
echo "Building index.html for ${OUT_DIR} ..."
{
  echo '<!doctype html>'
  echo '<meta charset="utf-8">'
  echo "<title>ICS ${MONTH} ${VERSION}</title>"
  echo '<style>body{font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial;max-width:800px;margin:20px auto;padding:0 12px} a{color:#0366d6;text-decoration:none} ul{line-height:1.9} code{background:#f6f8fa;padding:2px 4px;border-radius:4px}</style>'
  echo "<h1>ICS ${MONTH} ${VERSION}</h1>"
  echo '<p>아래 이름을 클릭해 .ics 파일을 내려받거나, 링크 주소를 복사하여 캘린더에서 “URL로 추가(구독)”하세요.</p>'
  echo '<ul>'
  for f in "$OUT_DIR"/*.ics; do
    bn=$(basename "$f")
    # HTML-safe name
    esc=$(printf '%s' "$bn" | sed 's/&/&amp;/g; s/</&lt;/g; s/>/&gt;/g')
    echo "<li><a href=\"./$esc\">$esc</a></li>"
  done
  echo '</ul>'
  echo '<hr>'
  echo '<p>예시(구독): Google 캘린더 &rarr; 설정 &rarr; 캘린더 추가 &rarr; <strong>URL로 추가</strong> &rarr; 위 링크 주소 입력</p>'
} >"$OUT_DIR/index.html"

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

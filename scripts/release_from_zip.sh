#!/usr/bin/env bash
set -euo pipefail

# Create a GitHub Release from a duty-roster ZIP, deriving tag (ics-YYYY-MM-vN) from filename.
# Requires: gh CLI authenticated with repo write access.
#
# Usage:
#   scripts/release_from_zip.sh path/to/duty-roster-2025-10-v3.zip [optional-xls]

ZIP_PATH=${1:-}
XLS_PATH=${2:-}

if [[ -z "$ZIP_PATH" || ! -f "$ZIP_PATH" ]]; then
  echo "Usage: $0 path/to/duty-roster-YYYY-MM-vN.zip [optional-xls]" >&2
  exit 2
fi

BN=$(basename "$ZIP_PATH")
if [[ ! "$BN" =~ ([0-9]{4}-[0-9]{2})-(v[0-9A-Za-z._-]+) ]]; then
  echo "Filename must contain YYYY-MM-vN (e.g., duty-roster-2025-10-v3.zip or v3a)" >&2
  exit 3
fi
MONTH="${BASH_REMATCH[1]}"
VERSION="${BASH_REMATCH[2]}"
TAG="ics-${MONTH}-${VERSION}"

TITLE="ICS ${MONTH} ${VERSION}"
BODY=$(cat <<EOF
Automated release from ZIP.

- Month: ${MONTH}
- Version: ${VERSION}

Includes per-person ICS files (ZIP). Optional Excel if attached.
EOF
)

echo "Creating release: $TAG"
gh release create "$TAG" "$ZIP_PATH" ${XLS_PATH:+"$XLS_PATH"} \
  --title "$TITLE" \
  --notes "$BODY" \
  --target main

echo "Published: $TAG"

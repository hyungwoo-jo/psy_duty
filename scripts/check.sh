#!/usr/bin/env bash
set -euo pipefail
OWNER=$(gh api user --jq .login)
REPO=psy_duty
echo "Remote Pages: https://$OWNER.github.io/$REPO/"
JS=$(gh api repos/$OWNER/$REPO/contents/src/app.js?ref=main --jq .content | base64 -d)
if echo "$JS" | rg -q "Stat-to-Pass|loadKRHolidays|duty-roster.xls"; then
  echo "Markers OK in remote app.js"
else
  echo "Markers missing in remote app.js"; exit 1
fi

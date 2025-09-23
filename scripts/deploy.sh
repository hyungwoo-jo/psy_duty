#!/usr/bin/env bash
set -euo pipefail
MSG="${1:-chore: deploy}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# Ensure on main
CUR=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
if [ "$CUR" != "main" ] && [ -n "$CUR" ]; then echo "Switching to main"; git checkout main; fi
# Commit (empty if needed) and push
if git diff --quiet && git diff --cached --quiet; then
  git commit --allow-empty -m "$MSG"
else
  git add -A
  git commit -m "$MSG"
fi
git push origin main
OWNER=$(gh api user --jq .login)
echo "Deployed. Pages: https://$OWNER.github.io/psy_duty/"

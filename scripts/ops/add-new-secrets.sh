#!/usr/bin/env bash
# Adds the three server secrets the organisations / player-identity release needs to
# the Vercel project mb-tournament (Production and Preview), each a fresh random
# value. Run it yourself — nobody else sees the values, and they are never printed.
#
#   bash scripts/ops/add-new-secrets.sh
#
# A secret that already exists is left alone (changing EVENT_CODE_PEPPER or
# PLAYER_CODE_PEPPER later voids every event code, invite and player code).
set -euo pipefail
cd "$(dirname "$0")/../.."

SCOPE="wahidechos-projects"
PROJECT="mb-tournament"
NAMES=(STAFF_SESSION_SECRET EVENT_CODE_PEPPER PLAYER_CODE_PEPPER)

if [ ! -f .vercel/project.json ]; then
  vercel link --yes --project "$PROJECT" --scope "$SCOPE" >/dev/null
fi

existing="$(vercel env ls --scope "$SCOPE" 2>/dev/null || true)"
for name in "${NAMES[@]}"; do
  for target in production preview; do
    if printf '%s\n' "$existing" | awk -v n="$name" -v t="$target" '$1 == n && tolower($0) ~ t { found = 1 } END { exit !found }'; then
      echo "• $name ($target) already set — left as it is"
      continue
    fi
    value="$(openssl rand -base64 48 | tr -d '\n=+/' | cut -c1-56)"
    if vercel env add "$name" "$target" --sensitive --value "$value" --yes --scope "$SCOPE" >/dev/null 2>&1; then
      echo "✓ $name ($target) added"
    else
      echo "✗ $name ($target) could not be added — add it in Vercel → Settings → Environment Variables"
    fi
    unset value
  done
done
echo
echo "Done. Values were generated here and sent straight to Vercel; they are not saved anywhere else."

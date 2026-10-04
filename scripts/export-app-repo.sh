#!/usr/bin/env bash
# Exports the Move Score app (move-score-app/) as a standalone repository that builds on its own.
#
# The app shares pure code with the web platform (scoring engine, API contract, lease, nations)
# through move-score-app/src/core/index.ts. In this repo that barrel points at ../src/lib; the export
# copies exactly those files into shared/ and points the barrel there instead. The platform repo stays
# the source of truth: change shared code here, then run this script to sync the app repo.
#
#   scripts/export-app-repo.sh <target-dir> [--push]
#
# <target-dir> is a clone of the app repo (created and git-initialised if missing). With --push the
# result is committed and pushed to its origin.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:?usage: scripts/export-app-repo.sh <target-dir> [--push]}"
PUSH="${2:-}"

# Everything src/core/index.ts reaches in src/lib (checked below with tsc in the export).
SHARED=(
  auth/password.ts
  auth/sessionRules.ts
  mobile/contract.ts
  mobile/alertsSwitch.ts
  mobile/oauth.ts
  friendly/mobile.ts
  players/accessCode.ts
  players/phone.ts
  scoring/conduct.ts
  scoring/console.ts
  scoring/engine.ts
  scoring/eventGuard.ts
  scoring/rules.ts
  scoringLease.ts
  site.ts
  tennis/nations.ts
  tennis/ties.ts
  types.ts
)

mkdir -p "$TARGET"
[ -d "$TARGET/.git" ] || git -C "$TARGET" init -q -b main

# App files (the target's own .git is left alone; files deleted in the app are deleted there too).
rsync -a --delete \
  --exclude .git --exclude node_modules --exclude android --exclude ios --exclude .expo \
  --exclude dist --exclude web-build --exclude design/prototype.html --exclude '*.log' --exclude shared \
  "$ROOT/move-score-app/" "$TARGET/"

rm -rf "$TARGET/shared"
for f in "${SHARED[@]}"; do
  mkdir -p "$TARGET/shared/$(dirname "$f")"
  cp "$ROOT/src/lib/$f" "$TARGET/shared/$f"
done

SHA="$(git -C "$ROOT" rev-parse --short HEAD)"
cat > "$TARGET/shared/README.md" <<EOF
# shared/

Pure TypeScript copied from the web platform (\`src/lib\` in WahidEcho/MB-Padel-Tour-managment,
commit $SHA): the scoring engine, the app API contract, the scoring lease and the nations list.
The app imports it only through \`src/core/index.ts\`.

Do not edit these files here. Change them in the platform repo and run
\`scripts/export-app-repo.sh\` there, so the app, the server and the web console keep scoring alike.
EOF

# Point the barrel at shared/ and drop Metro's extra watch folder.
sed -i '' 's#\.\./\.\./\.\./src/lib/#../../shared/#g' "$TARGET/src/core/index.ts"
sed -i '' 's#in \.\./src/lib (no database#in shared/ (no database#' "$TARGET/src/core/index.ts"
cat > "$TARGET/metro.config.js" <<'EOF'
// Standalone export: the shared engine lives in ./shared (see shared/README.md).
const { getDefaultConfig } = require("expo/metro-config");

module.exports = getDefaultConfig(__dirname);
EOF

if grep -rnE "from [\"'][^\"']*src/lib" "$TARGET/src" >/dev/null; then
  echo "error: the export still points at src/lib" >&2
  exit 1
fi

# Proof it stands alone: type-check the export with the app's own dependencies.
ln -sfn "$ROOT/move-score-app/node_modules" "$TARGET/node_modules"
(cd "$TARGET" && npx tsc --noEmit -p .)
rm "$TARGET/node_modules"
echo "type-check ok"

if [ "$PUSH" = "--push" ]; then
  git -C "$TARGET" add -A
  if git -C "$TARGET" diff --cached --quiet; then
    echo "nothing to sync"
  else
    git -C "$TARGET" commit -q -m "Sync from MB-Padel-Tour-managment@$SHA"
    git -C "$TARGET" push -q origin HEAD
    echo "pushed $(git -C "$TARGET" rev-parse --short HEAD)"
  fi
fi

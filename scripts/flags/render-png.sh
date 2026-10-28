#!/bin/sh
# Draws every public/flags/*.svg to public/flags/png/<code>.png (480x360, 4:3) in headless Chrome.
# The app loads these PNGs: iOS's SVG renderer (expo-image) drops clip paths and <use>, which broke
# Egypt, Korea, India, Serbia, Kazakhstan, Venezuela… Re-run after adding or changing a flag SVG.
# Usage (macOS): sh scripts/flags/render-png.sh
set -e
CH="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
mkdir -p "$ROOT/public/flags/png"
for f in "$ROOT"/public/flags/*.svg; do
  c=$(basename "$f" .svg)
  printf '<!doctype html><style>html,body{margin:0;background:transparent;overflow:hidden}img{display:block;width:480px;height:360px}</style><img src="file://%s">' "$f" > "$TMP/$c.html"
  "$CH" --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 --force-device-scale-factor=1 \
    --window-size=480,360 --screenshot="$ROOT/public/flags/png/$c.png" "file://$TMP/$c.html" >/dev/null 2>&1
done
rm -rf "$TMP"
echo "$(ls "$ROOT"/public/flags/png/*.png | wc -l | tr -d ' ') flags drawn"

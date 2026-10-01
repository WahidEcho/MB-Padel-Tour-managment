#!/usr/bin/env bash
# Installs the APK on the running emulator, opens the main screens against the live server and
# saves a screenshot of each to shots/. Fails if the app crashes or the server is unreachable.
set -euo pipefail

PKG=org.mbeg.movescore
API="${EXPO_PUBLIC_API_BASE_URL:-https://mb-tournament.vercel.app}"
APK=$(ls apk/*.apk | head -1)
mkdir -p shots

# Real ids from the live server, so the screens show real data.
SLUG=$(curl -sf "$API/api/mobile/v1/discover" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const j = JSON.parse(s);
    const all = [...j.featured.flatMap((g) => g.tournaments), ...j.live, ...j.upcoming, ...j.past];
    console.log(all[0]?.slug ?? "");
  });')
echo "tournament: $SLUG"
MATCH=$(curl -sf "$API/api/mobile/v1/t/$SLUG/live" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const m = JSON.parse(s).matches;
    const pick = m.find((x) => x.status === "live") ?? [...m].reverse().find((x) => x.stage === "final" && /^final$/i.test(x.round ?? "")) ?? m[m.length - 1];
    console.log(pick?.id ?? "");
  });')
PLAYER=$(curl -sf "$API/api/mobile/v1/t/$SLUG/bundle" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    console.log(JSON.parse(s).teams.flatMap((t) => t.players)[0]?.id ?? "");
  });')
echo "match: $MATCH  player: $PLAYER"

adb install -r "$APK"
adb shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS || true
adb logcat -c

alive() {
  if ! adb shell pidof "$PKG" >/dev/null; then
    echo "::error::the app is not running (crashed?)"
    adb logcat -d -t 400 > shots/logcat.txt
    exit 1
  fi
}
shot() {
  sleep "$2"
  alive
  adb exec-out screencap -p > "shots/$1.png"
  echo "saved $1"
}
open() {
  adb shell am start -W -a android.intent.action.VIEW -d "movescore://$1" "$PKG" >/dev/null
}

adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null
shot 01-discover 30
open "/t/$SLUG";            shot 02-tournament 15
open "/match/$MATCH";       shot 03-match 15
open "/matches";            shot 04-matches 10
open "/players";            shot 05-players 10
[ -n "$PLAYER" ] && { open "/player/$PLAYER"; shot 06-player 12; }
open "/pass";               shot 07-pass 10
open "/following";          shot 08-following 8
open "/referee";            shot 09-referee 8
open "/account";            shot 10-account 8

# The same app in dark mode.
adb shell cmd uimode night yes
adb shell am force-stop "$PKG"
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null
shot 11-discover-dark 20
open "/t/$SLUG";            shot 12-tournament-dark 12
open "/match/$MATCH";       shot 13-match-dark 12
open "/pass";               shot 14-pass-dark 10

# Connected: no network failures logged by the app's JavaScript.
adb logcat -d > shots/logcat.txt
if grep -E "ReactNativeJS.*(Network request failed|Can't reach Move Score)" shots/logcat.txt; then
  echo "::error::the app could not reach $API"
  exit 1
fi
echo "all screens captured"

# Installing a Live Activities + widgets build on an iPhone

Phase 6 adds to the iOS app:

- **Lock-screen cards (Live Activities), one per match**, in four phases: *soon* (next on
  court, countdown to the start), *called* (to court, countdown to the deadline), *live*
  (the score) and *final*. The server can **start a card by push** (iOS 17.2+) for a
  player's own match (`autoStartMine`) or a starred one (`autoStartStarred`), when the
  tournament's Match day tab allows it.
- **My matches widget**: home screen small and medium, lock screen rectangular, inline
  and circular. Rows come from `GET /api/mobile/v1/me/widget`.
- `remote-notification` background mode, and a patch to expo-widgets so cards started by
  push register their update token (see "Why the patch" below).

Code: `src/lib/notify/liveActivity.ts` (payloads, pure, tested), `src/lib/notify/apns.ts`
(`pushToStart`), `src/lib/notify/hooks.ts` (`notifyLiveActivityPhase`), route
`api/mobile/v1/me/live-activity/start-token`, app `src/live/*`.

## 1. Provisioning profiles — checked 13 Oct 2026

Read with `security cms -D -i <file>` from `~/MoveScore-keys/ios/` (entitlements only).

| Profile | App ID | App Group | Push (`aps-environment`) | Devices | Expires |
| --- | --- | --- | --- | --- | --- |
| `MoveScore.mobileprovision` (App Store) | `33C2U7Q76F.org.mbeg.movescore` | `group.org.mbeg.movescore` | production | — | 3 Oct 2027 |
| `MoveScore.adhoc.mobileprovision` (Ad Hoc) | `33C2U7Q76F.org.mbeg.movescore` | `group.org.mbeg.movescore` | production | 2 | 3 Oct 2027 |
| `ExpoWidgetsTarget.mobileprovision` (App Store) | `….org.mbeg.movescore.ExpoWidgetsTarget` | `group.org.mbeg.movescore` | (not needed) | — | 3 Oct 2027 |
| `ExpoWidgetsTarget.adhoc.mobileprovision` (Ad Hoc) | `….org.mbeg.movescore.ExpoWidgetsTarget` | `group.org.mbeg.movescore` | (not needed) | 2 | 3 Oct 2027 |

All four also carry Sign in with Apple (app only), associated domains `*` (app only) and
the team keychain group.

What the build asks for (checked with `npx expo config --type introspect` and a throw-away
`expo prebuild`):

- app: `aps-environment`, `com.apple.developer.applesignin`, associated domains
  (`applinks:tour.mbeg.org`, `applinks:mb-tournament.vercel.app`),
  `com.apple.security.application-groups = [group.org.mbeg.movescore]`;
- extension `org.mbeg.movescore.ExpoWidgetsTarget`: `com.apple.security.application-groups = [group.org.mbeg.movescore]`.

**Result: both the App Store and the ad-hoc profiles already have everything. No Apple
Developer portal change is needed** for Live Activities, push-to-start or the widgets:
Live Activities need no entitlement of their own, push-to-start uses the same APNs
token key as Live Activity updates, and `remote-notification` is an Info.plist
background mode, not an entitlement. (The entitlements file says
`aps-environment = development`, as every Expo build does; Xcode signs it with the
profile's `production`, as for the builds already on TestFlight.)

The only portal work that could come up — **for the owner to do, not the agent**:

1. **Your iPhone is not one of the 2 devices in the ad-hoc profiles.** Check:
   ```sh
   idevice_id -l                                   # the plugged-in iPhone's UDID
   security cms -D -i ~/MoveScore-keys/ios/MoveScore.adhoc.mobileprovision | plutil -extract ProvisionedDevices xml1 -o - -
   ```
   If it is missing: Developer portal → Devices → register it, then regenerate **both**
   ad-hoc profiles (Move Score and ExpoWidgetsTarget), download them over the two
   `.adhoc.mobileprovision` files.
2. **A different App Group** (`MS_APP_GROUP`): add it to both App IDs and regenerate all
   four profiles. Not needed with the default.
3. **Dev / staging bundles** (`org.mbeg.movescore.dev`, `.staging`) use expo-widgets'
   default group `group.<bundle id>`, which is not registered. Only matters if those builds
   are ever signed for a device; build them with `MS_LIVE_ACTIVITIES=0` otherwise.

### Switches (app.config.ts)

| Env | Effect |
| --- | --- |
| `MS_LIVE_ACTIVITIES=0` | No widget extension and no App Group at all: builds with profiles that lack the group (no lock-screen cards, no widget). |
| `MS_WIDGETS=0` | The extension carries only the Live Activity (no My matches widget). |
| `MS_APP_GROUP=group.…` | Another App Group id (must be in both profiles). |

Set them in the build profile's `env` in `eas.json` (or the shell for `expo prebuild`). The
app reads what the build has from `extra.liveActivities` / `extra.widgets`.

## 2. Before the first build (owner)

1. **Install the new dev dependency** (adds `patch-package` to the lockfile and applies the
   patch); EAS runs `npm ci`, which fails while `package.json` and `package-lock.json`
   disagree:
   ```sh
   cd move-score-app && npm install
   grep -c onExpoWidgetsActivityPushTokenReceived node_modules/expo-widgets/ios/WidgetsModule.swift   # 1 or more
   git add package-lock.json && git commit -m "Move Score: lockfile for patch-package"
   ```
2. **Server env on Vercel** (Production): `APNS_KEY_P8` (the `.p8` contents, `\n` for
   newlines), `APNS_KEY_ID`, `APNS_TEAM_ID=33C2U7Q76F`, `APNS_BUNDLE_ID=org.mbeg.movescore`.
   **Leave `APNS_SANDBOX` unset**: ad-hoc, TestFlight and App Store builds all use
   production APNs (only an Xcode debug build is sandbox).
3. **Flag**: platform setting `flags.live_activity = true` (it is false by default).
4. **Rules, test tournament only**: Admin → the test tournament → Match day → Live
   Activities on, Start by push on, Countdown on, Auto-start for my matches on.
   Leave every real tournament as it is.
5. `credentials.json` (local, not in git) must point `ios.MoveScore` and
   `ios.ExpoWidgetsTarget` at the two **ad-hoc** profiles for `adhoc-local` (and at the
   App Store ones for `production-local-creds`), with the distribution certificate
   `dist.p12`.

## 3. Build and install (owner)

```sh
cd move-score-app
eas build -p ios --profile adhoc-local          # downloads to a .ipa when done
# plug the iPhone in, unlock it, "Trust This Computer"
idevice_id -l                                    # shows the UDID
ideviceinstaller -i ~/Downloads/<build>.ipa       # or: ideviceinstaller install <file>.ipa
```

`ideviceinstaller`, `idevice_id` and `ideviceinfo` are installed on this Mac (Homebrew
`libimobiledevice` + `ideviceinstaller`). An install error about the profile means the
UDID is not in the ad-hoc profiles (step 1.1).

## 4. Gate 6 — the start-by-push spike first

Do this before relying on anything else; it proves the token, topic, payload and
attributes type end to end.

1. Open the app once (iOS 17.2+, Settings → Move Score → Live Activities on). The phone's
   push-to-start token lands in `live_activity_start_tokens` (one row for its
   `installation_id`; the token itself is never logged).
2. Find the phone's installation id: `push_devices` row with `platform = 'ios'` and your
   `user_id` (sign in first), newest `last_seen_at`.
3. **Close the app** (swipe it away), lock the phone, then:
   ```sh
   npx tsx --env-file=.env.local scripts/live-activity/start-spike.ts <matchId> <installationId> called 5
   ```
   Expected: an alert "Called to court" and a card with a 5:00 countdown, Dynamic Island
   compact shows COURT + timer. A `[apns] 403 …` log line means key / team / bundle id is
   wrong; `BadDeviceToken` means a sandbox/production mismatch (`APNS_SANDBOX`).
4. A row for that match and installation should appear in `live_activity_tokens` (the card
   can then be updated). iOS is expected to wake the app briefly for it; if the row only
   appears after you open the app, note the iOS version — that is the behaviour to expect
   without a background wake, and updates then start from the next app open.
5. Score a point on that match from the referee app: the card switches to the live score.
   Finish the match: the card shows Final and leaves the lock screen after 15 minutes.

## 5. On-device checklist

Lock screen cards
- [ ] Match screen → "Lock screen" on a live match starts a card; doing it for a **second**
      match keeps the first card (one per match); tapping it again on the first match
      updates that card instead of adding another.
- [ ] Tapping a card opens that match.
- [ ] Spike above passes for `called`, then `soon` (`… soon 3`), then `live`.
- [ ] Countdown reaches 0:00 and then reads "Now" after the next update; no crash when the
      deadline is already past.
- [ ] Airplane mode on a live card: it dims after about 2 minutes (stale date).
- [ ] Dynamic Island: compact, minimal and expanded views read correctly (iPhone 14 Pro+).
- [ ] Settings → Move Score → Live Activities **off**: no cards start by push (Apple stops
      issuing the token; a dead token is marked `disabled_at`).
- [ ] A tournament whose Match day tab has Live Activities off hides the "Lock screen" button.

Widgets
- [ ] Home screen: add My matches small and medium. Signed out: "Sign in to see your matches".
- [ ] Sign in with a claimed player code: the next match shows with time and court; a live
      one shows its score and comes first; medium shows up to three, each opens its match.
- [ ] Lock screen: add rectangular, inline and circular; they read in the tinted style.
- [ ] Star a match from another tournament: it appears on the widget.
- [ ] With the app open, an alert arrives → the widget refreshes within a few seconds.
- [ ] At a match's start time the widget redraws by itself (timeline), app closed.

Regression
- [ ] Alerts, sign-in, pass, story share and referee scoring work as before.
- [ ] Build with `MS_WIDGETS=0`: no widget in the gallery, cards still work.

## Why the patch

`patches/expo-widgets+57.0.22.patch` (applied by `patch-package` on `npm install`)
adds one event to expo-widgets' native module: `onExpoWidgetsActivityPushTokenReceived`
`{ activityId, pushToken, url }`, fed by `Activity.activityUpdates` and each
activity's `pushTokenUpdates`.

Without it, expo-widgets only reports update tokens for activities it has a JavaScript
object for — ones the app started, or ones `getInstances()` returns while the app runs.
A card **started by push** while the app is closed gets an update token that iOS hands
to the app (waking it in the background on iOS 18), but nothing was listening, so the
server could start the card and never update it. The event also carries the card's
deep link (`movescore://match/<id>`), the only place the match id lives, since
expo-widgets does not expose a card's link to JavaScript. Remove the patch when
expo-widgets reports activity tokens for push-started activities itself.

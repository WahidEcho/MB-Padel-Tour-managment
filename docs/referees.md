# Referees: personal PINs, master referees, calls for assistance

Owner decisions for the Junior Finals (Cairo, from 2 Nov 2026). Migration `0035_referees.sql`.

## In one paragraph

Every referee has their own 4-digit PIN. A court's QR / court code says **which court**; the PIN says **who**.
Any referee can work any court: scan the court's QR (or type its code), then type the PIN. A court code on its
own signs nobody in. **Every referee code needs a PIN** (owner's decision, 19 Oct 2026): court codes,
whole-event referee codes and master codes alike; only operator (TV) codes sign in without one. Master referees cover every court of the event group: they sign in with their own master
code plus their PIN, can score any match, add matches and generate them from the draw, and they hear every
court's **Call for assistance**. The organiser sees who is on which court right now and every call with its times.

## Organiser (Admin → Referees, `/admin/org/referees`)

- **Add referee**: name, phone, optional photo link, role (*Referee* or *Master referee*), optionally limited to
  one event group. The system makes the PIN (never 0000, 1111, 1234, 9876…; unique among the organisation's
  active referees) and shows it **once**. Only `HMAC-SHA256(EVENT_CODE_PEPPER, "<org>:<PIN>")` is stored; the PIN is
  never logged or audited.
- **New PIN**: the old PIN stops working and every sign-in of that person ends on their next request.
- **Remove**: PIN stops, sign-ins end, their master codes are revoked.
- **Master code** (master referees only): a personal code for the event group (or every open event), shown once,
  revoked on Event codes like any code.
- **On court now** (`/admin/org/referees/live`): per court, who signed in with their PIN and was seen in the last 20
  minutes; master referees on duty; what the named referees did (audit rows with their names); sign-in history.
- **Calls for assistance** (`/admin/org/referees/calls`): every call, open and closed, with requested /
  acknowledged (by whom) / resolved (by whom) times; the organiser can mark an open one resolved.
- Court codes and the QR sheet are unchanged (Admin → Event codes → Court codes); the sheet now says to type the PIN
  and how Move Score 1.0.1 does it.

## Signing in

| Where | How |
| --- | --- |
| New app | Scan the court QR (or type the code) → PIN screen → court console. `POST /api/mobile/v1/staff/session { code, pin }`. |
| Web console | `/login`: the code, then the PIN step (the code is held sealed in a 5-minute HttpOnly cookie, never in a URL). |
| **Move Score 1.0.1** | One field: `<code> <PIN>` or `<code>-<PIN>` (or both run together), for any referee code. Without the PIN it shows: "This referee code needs your 4-digit referee PIN: type the code, a space, then your PIN." |
| Whole-event referee code | The code, then the PIN (web PIN step without a court; app PIN screen "Referee"). |
| Master referee | Master code + their own PIN (another person's PIN is a wrong PIN). |

Answers of `staff/session`: 401 `{ code: "pin_required", court, master }`, 401 `wrong_pin`, 429 `pin_locked`.
Success adds `referee: { name, role }` (1.0.1 ignores it).

**Brakes** (failed attempts only; a right PIN is refunded; `takeRateLimit`, atomic): per code 5 wrong PINs within 5
minutes, then that code is **locked for 5 minutes** from the fifth wrong PIN (a right PIN too; `PIN_LOCK_MINUTES`);
per address 20 per 15 minutes. A
right court code without its PIN is not counted against the code brakes of `src/lib/staffLogin.ts`.

**Token**: the court/master code token carries `p` (referees.id) and `s` (referee_sessions.id). Every request re-reads
both (`refereeForToken`): removed referee, PIN reset after the token was signed, or an ended sign-in → 401
`referee_ended`. A referee-code token without a referee (signed before PINs, or a whole-event code signed before PINs
covered it) → 401 `pin_required`. Operator (TV) codes are unchanged and need no PIN.

## Audit

- `audit_logs.actor_name` / `actor_referee_id`: stamped from the request's referee on every audit row (claims,
  leases, calls to court, results, the desk's actions, LOGIN, calls for assistance).
- `score_events.created_by = "referee:<id>"`; each synced batch adds an audit row `SCORE_EVENTS` with the count.

## Master referees

Principal: console role `referee`, `referee.role = "master_referee"`, `scopeTournamentIds` = the code's event group
tournaments (or its one tournament, or the organisation's open events), re-read on every request. Reach
(`principalReaches`): those tournaments and their matches, every court; nothing else (no sessions, no other rows).
Permissions (`MASTER_REFEREE_PERMISSIONS`, `src/lib/auth.ts`): `score_match`, `check_in`, `edit_bracket`,
`generate_matches`, `manage_groups`; never codes, referees, teams, settings, messages or money; a scoped code, so no
organisation-level action. A master referee's PIN on a court code is just that court's referee.

Web: `/referee/master` (calls, court picker across both events, links to every event's match list) and
`/referee/tournaments/[id]/desk` (the admin desk's own `createManualMatch`, `regenerateMatches`, `generateTiesAction`,
placement draws). App: Referee → *Calls for assistance & courts* (`/referee/master`).

## Call for assistance

- Court referee (court code + PIN): big button on the web scoring screen, the web court list and the app console
  (`AssistanceCard`). `POST /api/mobile/v1/referee/assistance { action: "request", matchId? }`.
- One open call per physical court (unique index); a tap within 30 s is the same tap, later taps re-alert at most
  once a minute; new calls per court: 6 per 10 minutes (429).
- Alert: Expo push to the phones of master referees on duty (their app sign-in records the phone from the install
  token), `priority: high`, `interruptionLevel: time-sensitive`, Android channel `assistance` (max importance,
  vibration, bypasses Do Not Disturb), sound; plus a live banner with alarm sound and vibration on every web referee
  page of a master, and polling in the app. `PUSH_DRY_RUN=1` sends nothing.
- "On my way" (master; compare-and-set, the first one wins) → the court referee sees "<name> is on the way".
  "Resolved" (master or organiser). "Cancel" (the court referee, before anyone answered).
- Staff only: the route is `private, no-store`; no TV, public page or public API reads `assistance_calls`.

## Gates

- Unit: `src/lib/referees/*.test.ts` (PIN hashing / generation, 1.0.1 split, call state machine, master permissions
  and reach, tokens, On court now).
- `npm run e2e:referees` (stand-in; server with `PUSH_DRY_RUN=1`).
- `e2e:court-codes` and `e2e:old-app` sign in court codes with a PIN.

## Deploy

1. Owner applies `0035_referees.sql` on the live project **before** deploying (audit rows write `actor_name`).
2. After deploy: Admin → Referees, add each referee, hand out PINs; make master codes; print the court sheets again
   (new wording). Court codes made before keep working, but a referee signed in with one before the deploy has to
   sign in again with the PIN.
3. iPhone: `app.config.ts` carries the `com.apple.developer.usernotifications.time-sensitive` entitlement and the
   assistance push is sent with `interruptionLevel: "time-sensitive"`. Before the next build the owner enables
   **Time Sensitive Notifications** on the App ID in the Apple developer portal and regenerates the profiles
   (`move-score-app/docs/device-install.md`, step 2.6). Without it the signed build fails.
4. Whole-event referee codes now need a PIN too: referees signed in with one before this deploy sign in again with
   their PIN.

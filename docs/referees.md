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

After the code, the referee **picks their own name** from the list (the organisation's active referees open to the
code's event group; on a master code only that code's master referee; a master referee may pick themselves on a court
code and is then that court's referee), with their photo when the organiser added one and a search box for long lists,
then types their PIN. The server checks the PIN **against that referee only** (`referee_id` + PIN, constant-time
compare). Audit H1, owner-approved 20 Oct 2026.

| Where | How |
| --- | --- |
| New app | Scan the court QR (or type the code) → name + PIN screen → court console. `POST /api/mobile/v1/staff/session { code, refereeId, pin }`. |
| Web console | `/login`: the code, then the name + PIN step (the code is held sealed with its issued-at in a 5-minute HttpOnly cookie, never in a URL; the server refuses the seal after 5 minutes). |
| **Move Score 1.0.1** | One field: `<code> <PIN>` or `<code>-<PIN>` (or both run together), for any referee code. Without the PIN it shows: "This referee code needs your 4-digit referee PIN: type the code, a space, then your PIN." |
| Whole-event referee code | The code, then name + PIN (web step without a court; app screen "Referee"). |
| Master referee | Master code + their own PIN (the list holds only them). |

**PIN only (owner, 22 Oct 2026).** After a court or master code the referee types their PIN; no names are shown (anyone
scanning a court QR would otherwise see every referee's name). The PIN says who it is: PINs are unique per organisation,
so it is matched across the code's referees. A `refereeId` an older app still sends is honoured (then only that referee's
PIN matches).

Answers of `staff/session`: 401 `{ code: "pin_required", court, master, referees: [] }` (always empty now; installed apps
then skip their name step), 401 `wrong_pin` (the message says how many tries this phone has left), 429 `pin_locked`
(this phone), `pin_busy` (this address). Success adds `referee: { name, role }` (1.0.1 ignores it).

**Brakes** (`src/lib/referees/rules.ts`, `checkRefereePin` in `server.ts`; failed attempts only, a right PIN is refunded;
`takeRateLimit`, atomic; PINs never logged):

- **Per phone** (`PIN_PER_PHONE`): 5 wrong PINs from one phone (verified install token `app:<installation>`, or the
  browser's HttpOnly `__Host-mb_device` cookie `web:<id>`; the address for a client with neither) block **that phone** for
  5 minutes from the fifth (`PIN_LOCK_MINUTES`). There is **no per-referee and no per-court-code lock**: somebody spamming
  PINs can never lock the real referees out.
- **Per organisation** (`PIN_ORG_TIERS`, and `PIN_LEGACY_ORG_TIERS` for nameless attempts): counted for **alerts only**. The
  wrong PIN that fills a tier writes an audit row `REFEREE_PIN_BRAKE` (banner on Admin → Referees for 24 h) and emails the
  organisation's active owners and admins (`staff_alert`; `MESSAGING_DRY_RUN=1` sends nothing). Nobody is refused.
- **Per address**: a ceiling against scripts (60 wrong PINs per 15 minutes, `PIN_PER_IP`): a venue's Wi-Fi or a mobile
  carrier puts every referee behind one address, so it stays well above what referees ever type.

**Guessing trade-off (PIN only)**: every PIN is matched against all of the code's referees, so with N referees one guess
is worth N. With 10 referees the address ceiling still leaves someone holding a court code about a 6 % chance per 15
minutes from one address; the owners are emailed when the organisation tier fills (25 wrong in 10 minutes): give the
referees new PINs then. Court codes are 4 characters and printed at the courts, so the PIN is the only secret.

**Move Score 1.0.1 (former note)**: its one field cannot carry a name, so `<code> <PIN>` (and an older new-app build's
`{ code, pin }` without `refereeId`) is matched against every referee the code lists (PINs are unique per organisation),
under the organisation's tiers plus a tighter legacy budget of its own (`PIN_LEGACY_ORG_TIERS`: 10 wrong per 10 minutes,
30 per day), and the address ceiling; never a per-referee lock and no known-device bypass. Each such guess is worth one
guess at each listed referee, so with 40 referees the 30-a-day legacy budget still gives someone holding a court code
roughly a 12 % chance a day (40 × 30 / ~9 800 PINs); the organiser is alerted when the organisation tier fills. Retire the legacy path (refuse a PIN without `refereeId`) once 1.0.1 is gone from referees' phones.

A right court code without its PIN is not counted against the code brakes of `src/lib/staffLogin.ts`.

**Token**: the court/master code token carries `p` (referees.id) and `s` (referee_sessions.id). Every request re-reads
both (`refereeForToken`): removed referee, PIN reset after the token was signed, an ended sign-in, or a sign-in row past
its own `expires_at` → 401 `referee_ended`. A referee-code token without a referee → 401 `pin_required`. Operator (TV)
codes are unchanged and need no PIN.

**Switching courts (carry-over)**: the old court's code keeps reaching only the matches this device worked on (its
referee's own score events or its scoring lease) that the new code does not reach. A carry token never outlives the
token it came from or the referee's sign-in row, is never accepted as `previousToken`, and earlier carries survive a
second switch (the web keeps up to three, `mb_carry`, `mb_carry_2`, `mb_carry_3`).

**Finished matches**: a court code (or its carry-over) writes to a finished match (an UNDO that reopens it, any score
event) only within `CARRY_GRACE_MINUTES` (30) after it ended; afterwards 409 `conflict: "finished_locked"` (audit L4,
`finishedLockCut` in `src/lib/scoring/append.ts`). Master referees, whole-event codes and the organiser's staff are not
limited; a result correction stays the organiser's (`correctionCut`).

## Audit

- `audit_logs.actor_name` / `actor_referee_id`: stamped from the request's referee on every audit row (claims,
  leases, calls to court, results, the desk's actions, LOGIN, calls for assistance).
- `score_events.created_by = "referee:<id>"`; each synced batch adds an audit row `SCORE_EVENTS` with the count.

## Master referees

Principal: console role `referee`, `referee.role = "master_referee"`, `scopeTournamentIds` = the code's event group
tournaments (or its one tournament, or the organisation's open events), re-read on every request. Reach
(`principalReaches`): those tournaments and their matches, every court; nothing else (no sessions, no other rows).
Permissions (`MASTER_REFEREE_PERMISSIONS`, `src/lib/auth.ts`): `score_match`, `check_in` and `master_desk` (audit L3):
add a match, generate the group matches / ties and the placement draws, schedule a tie or match, delay the order of play,
release a stuck scoring lock; line-ups and scoring through `score_match`. Deleting matches, resetting / publishing a
bracket or its slots, creating / assigning / publishing groups and resetting the placement draws stay the organiser's
(`generate_matches`, `edit_bracket`, `manage_groups`; source-scanned in `src/lib/adminGuards.test.ts`). Never codes,
referees, teams, settings, messages or money; a scoped code, so no
organisation-level action. A master referee's PIN on a court code is just that court's referee.

Web: `/referee/master` (calls, court picker across both events, links to every event's match list) and
`/referee/tournaments/[id]/desk` (the admin desk's own `createManualMatch`, `regenerateMatches`, `generateTiesAction`,
placement draws). App: Referee → *Calls for assistance & courts* (`/referee/master`).

## Call for assistance

- Chair umpire (court code + PIN): big button on the web court list and the app console (`AssistanceCard`), and More →
  Call master referee on the scoring screens. `POST /api/mobile/v1/referee/assistance { action: "request", matchId? }`.
- Only while **Call master referee** (Admin → Scoring features, `features.callMaster`) is on for the match's event (or,
  without a match, any of the court's events): otherwise 409 `feature_off` (audit L1); `GET` tells the chair umpire
  `enabled` so the consoles hide the button.
- One open call per physical court (unique index); a tap within 30 s is the same tap, later taps re-alert at most
  once a minute; new calls per court: 6 per 10 minutes (429).
- Alert: Expo push to the phones of master referees on duty (their app sign-in records the phone from the install
  token), `priority: high`, `interruptionLevel: time-sensitive`, Android channel `assistance` (max importance,
  vibration, bypasses Do Not Disturb), sound; plus a live banner with alarm sound and vibration on every web referee
  page of a master, and polling in the app. `PUSH_DRY_RUN=1` sends nothing.
- **Coming / Decline** (migration `0042_assistance_responses.sql`): each master answers `POST { action: "respond",
  callId, answer: "coming" | "declined" }` from the desk (web `/referee/master`, app `referee/master`) or straight
  from the alert's buttons (notification category `assistance_call`, `move-score-app/src/push/assistanceActions.ts`;
  Coming opens the app on that call, Decline answers without opening it where the phone allows). Answers are rows
  of `assistance_responses` (call, master, name, answer, time).
  - Coming: the first one takes the call (compare-and-set open → acknowledged); every **other** master on duty gets
    "Master referee Sara is going to the emergency call at Court 2" (not time-sensitive, channel `matches`) and their
    desk shows "Sara is going · Court 2"; reminders stop. A later Coming: 409 `already_taken` with `takenBy`.
    Move Score 1.0.1's `acknowledge` ("On my way") is the same as Coming.
  - Decline: the call stays open for the others; that master gets no more reminders and may still press Coming
    while it is open.
- **Reminders**: while nobody has taken the call, every 30 s (`REMINDER_SECONDS`, at most `MAX_REMINDERS` = 20) the
  masters on duty who have not declined get the time-sensitive alert again ("Court 2 still needs a master referee —
  tap to answer"). One reminder per 30-second window: `tickCall` claims it with a compare-and-set on
  `assistance_calls.reminders_sent`, whoever reads the open call first: the court phone's 5-second poll (GET), a
  master's desk (GET), the organiser's GET, or the scheduled notification drain (`tickOpenCalls`, every minute, for
  when no phone is polling). Missed windows collapse into one reminder.
- **Escalation**: after 2 minutes unanswered (`ESCALATE_SECONDS`), or as soon as every master on duty declined, the
  organisation's active owners and admins get a push on their signed-in phones and a `staff_alert` email, once
  (`escalated_at` claimed where null). The call stays open.
- What the chair umpire sees (app `AssistanceCard`, web `AssistanceButton`, polled every 5 s): "Calling the master
  referees… no answer yet · 0:42" with "Reminder sent" and "Organiser alerted"; every master on duty with their
  answer (Coming since / Declined at / No answer yet, drawn icons); then "Sara is coming to Court 2" in green with the
  declines below; "Resolved by Sara" or "Call cancelled" for a minute after it closes. GET carries, additively,
  `going`, `responses: [{ name, answer: "coming" | "declined" | "none", at }]` (names only, never a phone or id),
  `remindersSent`, `escalatedAt`, and `mine` on a master's desk.
- Every push, the cards and the desks are in English, Spanish or French (`src/lib/referees/callWords.ts`, via
  `@core`; pushes in each phone's `push_devices.locale`). System steps are audit rows `ASSISTANCE_REMINDED`
  (`to`: master ids, `phones`), `ASSISTANCE_GOING_SENT`, `ASSISTANCE_ESCALATED` (`reason`); masters' answers
  `ASSISTANCE_COMING` / `ASSISTANCE_DECLINED`. The admin log shows declines and "Organiser alerted".
- "Resolved" (master or organiser). "Cancel" (the chair umpire, before anyone answered).
- Staff only: the route is `private, no-store`; no TV, public page or public API reads `assistance_calls` or
  `assistance_responses`.

## Gates

- Unit: `src/lib/referees/*.test.ts` (PIN hashing / generation, 1.0.1 split, call state machine, master permissions
  and reach, tokens, On court now; `callFlow.test.ts`: reminder windows, who is reminded, escalation, answers, words).
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
5. Owner applies `0042_assistance_responses.sql` on the live project **before** deploying the Coming / Decline build
   (the calls route selects its new columns). The reminders' backstop is the existing `movescore-drain-notifications`
   cron; nothing new to schedule. The push buttons need a new app build (older builds show the alert without
   buttons and answer on the desk).

# Plan: master referee calls — Coming / Decline, 30-second re-alerts, "X is going"

A prompt for a session working in this repository. Read `AGENTS.md` first (house rules), then `docs/referees.md`
§ "Call for assistance". Work on a branch, keep every gate below green, and never publish the app to the App
Store or TestFlight (iPhone builds only with `eas build --profile adhoc-local`).

## What the owner asked for

> When a court referee calls the master referees, each master answers **Coming** or **Decline**. If a master has
> not answered within **30 seconds**, alert them again on their phone as a **time-sensitive** notification. When
> one master answers Coming, the others are shown "Master referee X is going to the emergency call at Court 2".

Defaults chosen for what the owner did not specify. Keep them as constants in `src/lib/referees/rules.ts` so they
are easy to change:

- Re-alert every **30 s** each master on duty who has not answered, at most **5** re-alerts per call.
- If **every** master on duty declines, or **nobody** says Coming within **2 minutes**, escalate once to the
  organiser: an `assistance_unanswered` staff alert (push to the organiser's admin phones where they exist, plus a
  `staff_alert` email through `src/lib/messaging/queue.ts`). The call stays open.
- A master who declined can still change their mind and press Coming while the call is open.

## What exists today (do not rebuild)

- Table `assistance_calls` (migration `0035_referees.sql`): statuses `open | acknowledged | resolved | cancelled`,
  `acknowledged_by(_name)`, `alerted` (count of pushes), `taps`, `last_tap_at`. One open call per court (unique
  partial index).
- Server `src/lib/referees/assistance.ts`:
  - `requestAssistance`: a court referee's tap creates or joins the call.
  - `alertMasters(call)`: an Expo push to every master on duty (`mastersOnDuty` in `src/lib/referees/server.ts`).
    It is sent `priority: high`, `interruptionLevel: "time-sensitive"` and on Android channel `assistance`.
  - `actOnCall`: `acknowledge | resolve | cancel` (compare-and-set; the first acknowledge wins).
  - `callsForMaster`, `callForCourt`, `publicCall`.
- Pure rules `src/lib/referees/rules.ts`: `nextCallStatus`, `shouldRealert` (today a re-alert happens only when the
  court referee taps again, at most once a minute), `assistanceMessage`, `callStatusLine`. Tests in
  `src/lib/referees/rules.test.ts`.
- Route `src/app/api/mobile/v1/referee/assistance/route.ts`. GET returns the court's call (court referee) or the
  open and recent calls (master). POST takes `{ action: "request" | "acknowledge" | "resolve" | "cancel" }`.
  Audit rows `ASSISTANCE_*`.
- Web: the court button is `src/components/referee/AssistanceButton.tsx`; the master list is
  `src/components/referee/MasterCalls.tsx` on `/referee/master`. It has a banner and alarm, and shows
  "X on the way since HH:MM".
- App:
  - `move-score-app/src/referee/AssistanceCard.tsx` and `useCall.ts` (court side);
  - `move-score-app/src/app/referee/master.tsx` (master list, polling);
  - the Android channel `assistance` in `move-score-app/src/push/register.ts`.
- Gate: `npm run e2e:referees` (stand-in, server with `PUSH_DRY_RUN=1`).

What is missing: per-master answers, Decline, automatic re-alerts, telling the other masters who is going, and
escalation.

## Build

### 1. Migration `supabase/migrations/00NN_assistance_responses.sql`

Use the next free number; `0041` is the latest on main. Follow `src/lib/migrations.test.ts`: RLS enabled, no
policies, nothing granted to anon or authenticated.

- New table `assistance_responses`:
  - columns: `call_id uuid references assistance_calls(id) on delete cascade`, `referee_id uuid`,
    `referee_name text`, `response text check (response in ('coming','declined'))`, `responded_at timestamptz`;
  - `primary key (call_id, referee_id)`, so a master's later answer replaces the earlier one with an upsert.
- `assistance_calls`: add
  - `last_alert_at timestamptz` (set by every push, the first included);
  - `realerts integer not null default 0`;
  - `escalated_at timestamptz`.
- Classify the new table as private in `src/lib/gateSql.test.ts`.
- The owner applies the migration on the live project **before** the deploy. Say so in `AGENTS.md`.

### 2. Pure rules (`src/lib/referees/rules.ts`, with tests)

- Constants: `REALERT_EVERY_SECONDS = 30`, `MAX_REALERTS = 5`, `ESCALATE_AFTER_SECONDS = 120`.
- `pendingMasters(dutyIds, responses)`: the masters on duty with no answer yet. A master who declined is not
  pending.
- `realertDue(call, nowMs)`: the call is `open`, `now - last_alert_at >= 30 s` and `realerts < MAX_REALERTS`.
- `escalationDue(call, dutyIds, responses, nowMs)`: the call is `open`, `escalated_at` is null, and either every
  master on duty declined or `now - requested_at >= 120 s`.
- `goingMessage(masterName, court)`: "Master referee X is going to the emergency call at Court 2".
- `callStatusLine`: add the declined count for masters ("2 declined").

### 3. Server (`src/lib/referees/assistance.ts`)

- **`respondToCall(staff, callId, "coming" | "declined")`**, masters only:
  - Coming: upsert the response, then run today's `acknowledge` compare-and-set. If it wins, push
    `goingMessage` (not time-sensitive, channel `matches`) to every **other** master on duty, and the court
    referee's phone sees "X is on the way" as today. If someone else already acknowledged, return 409
    `already_taken` with that master's name.
  - Declined: upsert the response, then check `escalationDue` at once (all masters declined).
- **`alertMasters(call, onlyRefereeIds?)`**: optionally limit the push to the pending masters. Set
  `last_alert_at`.
- **`tickCall(call, nowMs)`**: idempotent; one function does every timed step.
  - When `realertDue`: claim the step with a compare-and-set on `realerts` / `last_alert_at` so two callers
    never double-push, then push the pending masters. The push is time-sensitive, with title
    "Call for assistance — no answer yet" and the body from `assistanceMessage`.
  - When `escalationDue`: claim it by setting `escalated_at` with a compare-and-set, then send the organiser
    alert.
- **Who runs `tickCall`**: no new scheduled job.
  - The court referee's console already polls GET every few seconds. Run `tickCall` on that GET while the call is
    open. The masters' GET does the same.
  - Backstop for phones that stop polling: run `tickCalls()` (open calls only, limit 50) from the existing
    notification drain. That is the `movescore-drain-notifications` cron, every minute, in
    `src/lib/notify/drain.ts`'s entry point.
- `publicCall` gains, additively, `responses: [{ name, response, at }]` and `going: name | null`.
  - Never remove a field; Move Score 1.0.1 reads these responses (`npm run e2e:old-app`).
  - Never put ids or phone numbers in these responses.

### 4. Route (`api/mobile/v1/referee/assistance`)

- POST `{ action: "respond", callId, response: "coming" | "declined" }`: masters only, audit
  `ASSISTANCE_COMING` / `ASSISTANCE_DECLINED`.
- Keep `acknowledge` working: it is Coming for 1.0.1 builds.

### 5. Web (`MasterCalls.tsx`)

- Each open call has two big buttons, **Coming** and **Decline**. After an answer, show "You: Coming"; after a
  Decline, show "Declined — change to Coming".
- When another master took it, stop the alarm and show "Master referee X is going to Court 2" in place of the
  buttons.

### 6. App

- `move-score-app/src/app/referee/master.tsx`: the same two buttons and the same lines.
- Push buttons: register a notification category `assistance` with actions **Coming** and **Decline**
  (`Notifications.setNotificationCategoryAsync` in `src/push/register.ts`; `opensAppToForeground: false` for
  Decline). Send the push with `categoryId: "assistance"`. Handle the action response by posting `respond` with
  the master's token. A tap on the notification body still opens `/referee/master`.
- Keep the Android channel `assistance` (max importance) and the iPhone time-sensitive entitlement as they are.
- Build for the owner's phone only: `eas build --profile adhoc-local` (iPhone) or `--profile apk` (Android, after
  `docs/android-push.md`).

## Tests and gates

- Unit tests (`src/lib/referees/rules.test.ts`):
  - pending masters;
  - a re-alert is due at 30 s and not at 29 s, and stops after 5;
  - escalation when all decline and at 120 s, and only once;
  - the wording of `goingMessage`.
- Extend `scripts/e2e/referees.ts` (stand-in, `PUSH_DRY_RUN=1`; push tickets read `dry-run`). Use two masters on
  duty and one court referee:
  1. The court referee calls, and both masters are alerted.
  2. At 30 s, a re-alert goes only to masters with no answer. Move time forward with the existing `nowMs`
     parameters; no real waits.
  3. Master A declines. Master B says Coming: the call is acknowledged, A gets the "B is going to Court N" push,
     and the court referee sees B on the way.
  4. A's later Coming gets 409 `already_taken`.
  5. A second call where both decline is escalated once.
  6. `tickCall` run twice in parallel pushes once.
- Keep green:
  - `npm run lint`, `npx tsc --noEmit`, `npx vitest run`, `npm run build`;
  - `npm run e2e:referees`, `npm run e2e:court-codes`, `npm run e2e:old-app`;
  - the app's `npx tsc --noEmit` in `move-score-app/`.
- Update `docs/referees.md` § "Call for assistance" and the `AGENTS.md` referee line. Name the migration and say
  it must be applied before the deploy.

## Done when

- On a real phone, a court referee's call reaches two master phones.
  - One master ignores it and gets a time-sensitive re-alert at about 30 s.
  - The other taps **Coming** from the notification.
  - The first master's phone then shows "Master referee X is going to the emergency call at Court N", and its
    alarm stops.
- A call that nobody answers for 2 minutes reaches the organiser.

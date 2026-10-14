# Registration — manual test guide

A step-by-step walkthrough of registration and payment on your Mac, against the local test database and a
fake Move Tick checkout. No real money, no real emails, nothing touches the live site.

Rules being tested (your decisions):

| Rule | What you should see |
|---|---|
| Register in Move Score, pay through Move Tick | Pay opens a (fake) Move Tick checkout |
| First paid, first in (default) | Registering holds nothing; the entry is **confirmed automatically** the moment payment succeeds |
| Organiser approval (per-event option) | "Waiting for the organiser" — no Pay button until you approve |
| Who pays for a team | Per event: registering player pays for all, or each player their share |
| Refunds | Always in full; allowed until 24 h before the start; never after |
| Entry type | Per event: individual, team, or both (player picks) |
| Player code | Archived 24 h after the event ends; results kept |

## 0. Setup (once, about 5 minutes)

Open three terminal tabs in the project folder.

Terminal 1 — test database:

```bash
npm run localdb
```

Terminal 2 — build, then start the site in test mode:

```bash
npm run build
```

```bash
(set -a; . ./.env.localdb; set +a; PUBLIC_SITE_URL=http://localhost:3077 PUSH_DRY_RUN=1 MESSAGING_DRY_RUN=1 npx next start -p 3077)
```

Terminal 3 — the fake Move Tick checkout:

```bash
npx tsx --env-file=.env.localdb scripts/demo/fake-move-tick.ts
```

Then, in any spare terminal, create the two demo events:

```bash
npx tsx --env-file=.env.localdb scripts/demo/registration-demo.ts
```

It prints the links you need:

- **Registration Demo Cup**: first paid, first in · solo or team of 2 · EGP 500 per player · 4 player places
  (2 teams) · starts in 3 days. Public form: `http://localhost:3077/register/registration-demo-cup`.
- **Registration Demo Cup (approval)**: the organiser approves · teams of 2 · EGP 500 per player · 2 teams.
  Public form: `http://localhost:3077/register/registration-demo-approval`.
- An **admin sign-in line** (`document.cookie = "mb_session=…"`). Open `http://localhost:3077`, open the
  browser's DevTools console (⌥⌘J in Chrome), paste the line, press Enter. You're now the Move Beyond admin
  (can approve, pair and refund). Need a fresh one later:
  `npx tsx --env-file=.env.localdb scripts/demo/registration-demo.ts session`.

Emails are not really sent in test mode. Whenever a step says "open the emailed link", get it with:

```bash
npx tsx --env-file=.env.localdb scripts/demo/registration-demo.ts links
```

Tip: use a second browser window (or a private window) for "another player" so the admin sign-in stays
in the first one.

## A. Solo player, first paid first in

1. Open the Cup's public form. Check the box at the top says: *first paid, first in … 4 player places left*
   and *Full refunds until …*.
2. Choose **On my own**, fill name, mobile (e.g. `01001110001`), email (e.g. `solo.one@example.test`),
   press **Register · EGP 500**.
   → *Thank you — we emailed you a link.*
3. Run the `links` command, open the **confirm** link, press **Confirm my registration**.
   → *Waiting for payment* and a **Pay EGP 500** button. Admin shows the entry as "holds no place until paid".
4. Press **Pay EGP 500** → fake checkout (*FAKE MOVE TICK · TEST MODE*, a 15:00 countdown) → **Pay (test)**.
   → Back on the status page: **Confirmed** — no organiser step.
5. Public form now says **3 player places left**.

## B. Team entry and the price

1. Public form → **As a team of 2**. Team name `Team Alpha`, your details, partner name and mobile.
   → The button reads **Register · EGP 1,000** (2 × 500, registering player pays for both).
2. Confirm via `links`, Pay, **Pay (test)** → **Confirmed**.
3. Public form now says **1 player place left** and only offers **On my own** (a team no longer fits).

## C. Two players racing for the last place

1. Register two more solo players (`Solo Two`, `Solo Three`) and confirm both emails (`links`).
2. In window 1, Solo Two presses **Pay** → stays on the checkout page (don't pay yet).
3. In window 2, Solo Three presses **Pay**.
   → **No checkout**; a message that the event is full / places are being paid for. Admin shows
   *4 of 4 player places taken … counting confirmed entries and open checkouts*.
4. Solo Two presses **Pay (test)** → **Confirmed**.

Optional — a checkout that's abandoned frees the place: restart the fake Move Tick with
`FAKE_MT_TTL_MINUTES=2 FAKE_MT_CLOSE_AFTER_MINUTES=2` in front of the command, let a checkout sit for 2 minutes,
then another player's **Pay** works.

## D. Failed payment

1. As a player waiting for payment, press **Pay** → on the checkout press **Fail (test)**.
   → Back to *Waiting for payment* with a message that the payment didn't go through and nothing was charged;
   **Pay** works again.
2. **Pay** → **Pay (test)** → **Confirmed**.

## E. Admin: pairing solo players

1. Admin → the Cup → **Registrations** tab (link printed by the seed).
2. Under **Pair solo players into teams**, tick two confirmed solo players → **Pair the two ticked**.
   → They no longer say "not in a team yet"; the pair appears as one team on the **Teams** tab.

## F. Admin: refunds (always full, never after the cut-off)

1. On a confirmed entry, press **Refund … in full** *without* typing anything.
   → An inline message asks you to type REFUND (the page must **not** crash). Nothing is refunded.
2. Type `REFUND` in the box, press **Refund … in full**.
   → The entry moves to **Refunded** with the full amount; the places count goes down.
3. A player that was turned away as "full" can now Pay and be **Confirmed**.
4. Cut-off: in Admin → the Cup → **App** tab → **First match (start time)**, move it to less than 24 hours from
   now and press **Save**; the public form's "Full refunds until …" line moves with it. Then try a refund →
   refused inline: *Refunds closed 24 hours before the event's start time.* (Put it back afterwards.)
   For your own real tournaments: set this start time before opening registration, or no refund can be made.

## G. Organiser approval event

1. Open the approval event's public form, register a team, confirm via `links`.
   → *Waiting for the organiser* — **no Pay button**.
2. Admin → approval event → **Registrations** → **Approve**.
3. Reopen the player's **status** link → **Pay EGP 1,000** appears, with the time the place is kept until
   (24 h).
4. Pay → **Pay (test)** → **Confirmed**. Try **Refuse** on another entry → it shows as refused, no Pay.

## H. Settings per event

Admin → Registrations → **Taking registrations**: check you can choose
- Entry: **Teams / Individual players / Both**;
- Approval: **First paid, first in** / **The organiser approves each entry**;
- Payment: at the venue / online / player picks / free;
- Who pays for a team: registering player / each player their share;

and that there is **no** card-fee setting (refunds are always 100 %). Change Entry to **Individual players**,
save, reload the public form → only "On my own". Set Payment to **Free**, register → **Confirmed** at once.

## I. In the app (optional)

Point the app at your Mac (`EXPO_PUBLIC_API_BASE_URL=http://<your-mac-ip>:3077`) and sign in with an email
account: tournament page → **Register** → after registering the app goes straight to Pay → after payment the
entry shows **Confirmed** under **My profile → Registrations**. Anonymous / player-code accounts are asked to
add a confirmed email first.

## Clean up

```bash
npx tsx --env-file=.env.localdb scripts/demo/registration-demo.ts remove
```

Stop the three terminals with Ctrl-C (the test database lives in memory and disappears).

## What was verified automatically

`npm run e2e:registration` (stand-in) covers all of the above plus attacks: forged or replayed Move Tick
webhooks, double payments, someone else's payment id, another organisation's admin, capacity races, and late
payments into a full event (flagged and refundable in full).

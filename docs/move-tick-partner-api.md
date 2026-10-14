# Move Tick partner API (Move Score registrations)

> **Since 14 Oct 2026 Move Score takes payments directly through XPay** (`docs/xpay-direct.md`), so Move Tick's
> live ticket code does not change. This partner API stays available as the alternative
> (`PAYMENT_PROVIDER=move_tick`, `src/lib/payments/provider.ts`) and is still covered by
> `npm run e2e:registration` (run with `PAYMENT_PROVIDER=move_tick`).

Move Score takes registrations; Move Tick takes the money. Players register for a tournament or a
friendly session in Move Score (the app, or the public web form at `/register/<slug>`); when the entry
fee is paid online, Move Score asks Move Tick for a hosted XPay checkout and Move Tick tells Move Score
what happened through signed webhooks. Move Score never sees a card, and Move Tick never decides who
may register or be refunded.

Online payment is offered **only for the Move Beyond organisation's events** (no payouts to other
organisations yet) and only while Move Tick is configured on the server. Everywhere else a fee is paid
at the venue. Plan: Phase 9; decisions: `DECISIONS.md` § 8.

- Move Score side: `src/lib/registration/` (`rules.ts` pure, `moveTick.ts` client, `signature.ts`,
  `server.ts`), webhook `src/app/api/webhooks/move-tick/route.ts`, migrations `0028_registration.sql`,
  `0029_registration_hardening.sql`, `0030_registration_first_paid.sql`, gate `npm run e2e:registration`
  (with a fake Move Tick inside the script). Local demo: `scripts/demo/registration-demo.ts` +
  `scripts/demo/fake-move-tick.ts`.
- Move Tick side: branch `move-score-partner-api` of the Move Tick repo — `src/services/partner-payments.service.ts`,
  `src/app/api/partner/v1/**`, `src/lib/partner/`, migration `20261069_partner_payment_sessions.sql`,
  tests `src/test/partner-payments.test.ts`, setup `docs/MOVE_SCORE_PARTNER_API.md`.

## 1. Move Score → Move Tick (server to server)

Base URL: `MOVE_TICK_API_URL` (e.g. `https://move-tick.mbeg.org`). Every call carries
`Authorization: Bearer <MOVE_TICK_PARTNER_KEY>` (Move Tick: `MOVE_SCORE_PARTNER_KEY`, compared in
constant time). JSON in and out; unknown fields are refused (400). Money is **integer minor units
(piastres), currency `EGP` only**. Refusals are `{ "code": "<CODE>", "error": "<text>" }`.

### Create a payment session

```
POST /api/partner/v1/payment-sessions
Idempotency-Key: <Move Score's registration_payments.id>
{
  "reference":   "<registration id (uuid)>",
  "amount":      50000,                 // the registration row's amount_online, never a client's number
  "currency":    "EGP",
  "description": "Team Cup — entry",    // ≤ 140 characters
  "returnUrl":   "https://tour.mbeg.org/register/status?r=<id>&s=<signed>",
  "customer":    { "name": "…", "email": "…" | null, "phone": "+20…" | null }
}
→ 201 (or 200 for a key seen before)
{
  "sessionId":   "<Move Tick partner session id>",
  "checkoutUrl": "https://…xpay…",      // the hosted checkout the payer is sent to
  "status":      "open",
  "amount":      50000,
  "currency":    "EGP",
  "reference":   "<registration id>",
  "expiresAt":   "…" | null,          // creation + 15 minutes (PARTNER_SESSION_TTL_MINUTES)
  "testMode":    true | false           // XPay sk_test_ key
}
```

- **A checkout lives 15 minutes**, and Move Score keeps the registration's place for exactly that long
  ("first paid, first in": `CHECKOUT_HOLD_MS` on Move Score, `PARTNER_SESSION_TTL_MINUTES` on Move Tick).
  Move Score makes a checkout only after it took that place hold (atomically, while a place is free);
  with no place free the payer is told "This event is full" and Move Tick is never called. XPay's own page
  lives 30 minutes (its minimum): Move Tick closes it at XPay once `expiresAt` passed (housekeeping every
  5 minutes, or the next create for the reference; never while a card is completing on it). A payment that
  still lands in between is reported as usual and Move Score confirms it only if a place is free then.

- **Idempotent** on `(partner, Idempotency-Key)`: a retry returns the same session; the same key with
  another reference or amount is `409 IDEMPOTENCY_KEY_REUSED`.
- A reference already paid is never charged again: `409 ORDER_ALREADY_PAID`.
- **One open checkout per reference** (both sides, atomic): Move Tick refuses a create under a new key while
  another session of the reference is `creating`/`open` with `409 PAYMENT_SESSION_OPEN` (one whose
  `expiresAt` passed is first closed as `expired`, and `payment.expired` sent); a partial unique index
  (`partner_payment_sessions_one_open_uq`) decides between two simultaneous creates. Move Score keeps one
  open checkout per registration (`registration_payments_one_open_uq`, migration 0029), **reuses it** when
  the payer presses Pay again, and before making a new one asks Move Tick how the last one ended (a
  checkout whose time ran out is never replaced until Move Tick has closed it).
- `customer` carries the registrant's name and only the entry's **verified** email (an app account's
  confirmed email, or a web guest's address once its emailed link was opened); never a typed phone.
- `returnUrl` must be an https page on one of the partner's own origins (`MOVE_SCORE_RETURN_ORIGINS`,
  default `https://tour.mbeg.org`; http only on localhost).
- Below XPay's card minimum (50 EGP): `422 PRICE_BELOW_CARD_MINIMUM`. Payments not configured on Move
  Tick: `503 PAYMENT_PROVIDER_UNAVAILABLE`; XPay unreachable: `502`.
- Move Score checks the answer echoes its reference and amount, and that `testMode` matches its own
  `MOVE_TICK_MODE`; anything else is treated as a failure.

### Read a session (reconciliation)

```
GET /api/partner/v1/payment-sessions/{sessionId}   → the same shape, or 404 PAYMENT_NOT_FOUND
```

Move Score uses it when a webhook may have been lost (the payer's return page, My registrations, Pay
again): the answer goes through the same idempotent path as a webhook (event id
`reconcile:<session>:<status>`), amount check included. It asks about open checkouts **and ones it marked
`expired` or `failed`** (a late payment is not lost), each payment **at most once per 30 seconds** (`reconciled_at`,
a compare-and-set), except right before a new checkout would be made. Before Move Tick opens a new session for a reference whose last checkout lapsed, it reads that checkout at XPay and closes it there (never while a card is still being authorised), so an old payment page can't take money later.

### Refund

```
POST /api/partner/v1/payment-sessions/{sessionId}/refund
{ "reference": "<registration id>", "amount": 50000, "reason": "…" }
→ 200 { "refundId": "re_…", "status": "refunded" }      // or "refund_pending" (then a webhook follows)
```

- Only the **organiser's refund action** in Move Score calls it (Admin → event → Registrations, admins
  signed in with their own account, typed confirmation, audited). The action names **one payment** (its
  id), so a registration holding two payments can have the extra one refunded. The payment that
  confirmed the entry: only until **24 hours before the event's start time** (`tournaments.starts_at`),
  and refunding it refunds the entry (it leaves the event). A payment **held for review after it was
  taken** — paid when the event was already full (its place hold had run out), paid after the entry was
  cancelled or refused, or a second payment for an entry already paid (flagged automatically, admins
  emailed) — can be refunded **at any time** (it bought nothing) and leaves the entry as it is. Players
  can only *ask* for a refund.
- **Refunds are always 100 %** (the owner's decision: Move Beyond absorbs the card fee; Move Score has no
  card-fee setting). Move Score always sends the payment's whole amount; Move Tick refuses anything else
  with `422 PARTIAL_REFUND_UNSUPPORTED` (XPay refunds a payment intent whole).
- Idempotent per session (`movetick-partner-refund-<session>` at XPay); a second call answers
  `refunded` without refunding again; not paid: `409 REFUND_PAYMENT_NOT_CHARGED`.

## 2. Move Tick → Move Score (webhooks)

```
POST https://tour.mbeg.org/api/webhooks/move-tick
Content-Type: application/json
MoveTick-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
MoveTick-Event-Id: evt_…

{
  "id": "evt_…",
  "type": "payment.succeeded" | "payment.failed" | "payment.expired" | "payment.refunded",
  "createdAt": "…",
  "data": {
    "sessionId": "…",
    "reference": "<registration id>",
    "amount": 50000,
    "currency": "EGP",
    "refundedAmount": 50000 | null,
    "testMode": false
  }
}
```

The secret is `MOVE_TICK_WEBHOOK_SECRET` on Move Score and `MOVE_SCORE_WEBHOOK_SECRET` on Move Tick (the
same value, 32+ random characters). The scheme is the one XPay signs Move Tick's own webhooks with.

Move Score's checks, in order (`src/lib/registration/signature.ts`, `server.ts applyWebhook`):

1. **Signature**: header present and well formed, timestamp within **5 minutes** either way (replay
   window), HMAC compared in **constant time** (several `v1=` values allowed for rotation). Else `401`.
2. **Shape**: exactly the fields above (reference a uuid, whole-number amount). Else `400`.
3. **Idempotency**: the event id is recorded in `move_tick_events` first; a replay (a unique-key refusal,
   `23505`, and nothing else) answers `200 {"duplicate": true}` and changes nothing; any other database
   error is a `500` (Move Tick retries). Every status change is also conditional on the status
   it moves from, keyed by the **reference** (a fresh event id for an already-applied change does
   nothing either).
4. **Ownership**: the session id must be one Move Score created, for exactly that reference.
5. **Mode**: `testMode` must match Move Score's `MOVE_TICK_MODE` (a test-card payment never confirms a
   real entry).
6. **Amount**: `payment.succeeded` must carry exactly the amount and currency Move Score asked for;
   otherwise the payment is held as `needs_review` and the entry is not confirmed.

Effects: `payment.succeeded` → payment `paid`, registration `awaiting_payment → confirmed` with no
organiser step (the full online amount of the entry, `amount_online`, re-checked), the entry is made in
the event and the registrant's own player row is linked to their account. Not confirmed, kept as
`needs_review` for the organiser to refund in full: paid when the event was already full (the place hold
had run out and the places were taken: the organisation's admins and the player are emailed), paid after
the entry was cancelled or refused, or for less than the entry owes. `payment.failed` /
`payment.expired` → the checkout is closed and the place hold it took ends (the player can pay again
while a place is free); `payment.refunded` → payment
`refunded`; when it was the payment that confirmed the entry, registration `refunded` and the entry leaves
the event (a team that already has matches stays, for the organiser); a payment held for review leaves the
entry as it is. A second `payment.succeeded` for an entry already paid is recorded `paid` then
`needs_review` ("A second payment … refund it"), audited `REGISTRATION_PAYMENT_DUPLICATE`, and the
organisation's owners and admins are emailed.

**Refunds Move Score did not ask for** (decided in the security review of Phase 9): `payment.refunded`
for a payment that was not `refund_pending` (Move Tick or XPay refunded on their side: a dispute, a
refund from Move Tick's dashboard) is **accepted** — the money is back with the payer either way — but
audited apart (`REGISTRATION_REFUND_EXTERNAL`) and the organisation's owners and admins are emailed to
check the entry.

Answers: `200` when applied, already applied, or about nothing of Move Score's (Move Tick stops
retrying and learns nothing about which references exist); `400`/`401` for malformed or unsigned
requests (not retried); `503` when Move Tick is not configured on Move Score; `500` on an error (Move
Tick retries: the event id is released so the retry is not mistaken for a replay).

Move Tick delivers each event once at once, then retries due ones with back-off (1, 2, 4 … minutes, at
most 6 hours, 10 attempts; a 4xx other than 408/429 stops retrying) from `/api/cron/partner-webhooks`
and the daily housekeeping cron.

## 3. Statuses

| Registration (Move Score) | Meaning |
|---|---|
| `unconfirmed` | a web guest's entry until the link emailed to the typed address is opened (24 h, then cancelled); holds no place, reaches no organiser, never paid |
| `pending_approval` | organiser mode only: waiting for the organiser |
| `awaiting_payment` | online payment due. **First paid, first in** (default): holds **no place** until Pay opens a checkout, which keeps one for **15 minutes** (`hold_kind = 'checkout'`) only if a place is free — otherwise Pay answers "This event is full" before any checkout; the hold ends when the checkout is paid, fails or expires. **Organiser mode**: approved; keeps its place for 24 h from approval (`hold_kind = 'approval'`), a checkout in its last 15 minutes stretching it once to at most 24 h 15 min; after that it pays like a first-paid entry |
| `confirmed` | in the event: paid in full online (no organiser step in first paid, first in), due at the venue, or free |
| `refused` / `cancelled` | turned down by the organiser / withdrawn by the player before paying |
| `refunded` | paid online and refunded (always in full) by the organiser |

| Payment (both sides) | |
|---|---|
| `created`/`creating` → `open` → `paid` → `refund_pending` → `refunded` | the happy path |
| `failed`, `expired` | closed unpaid; the place hold ends; a new checkout can be made (at most 6 per entry per 24 h) |
| `needs_review` | paid when the event was full, after the entry was cancelled, a second payment, or an amount that did not match: a person decides (refund in full at any time) |

Capacity is counted in players and covers `confirmed` entries and unexpired holds only (never unpaid
first-paid entries, requests waiting for the organiser or unconfirmed guests), enforced atomically by the
trigger `registration_capacity_guard` (0030, replacing 0029's): the setting is in entries of the event's
size (teams for team or both entry — a team fills `team_size` places, a solo player one — players for
individual entry). One live entry per verified email per event (`registrations_contact_event_uq`). The
web form is limited per typed email: 3 per event and 10 overall (atomic counters).

Messages about an entry go **by email only, to its verified address only** (`registrations.notify_email`),
in the server's own words with no typed name; the link is the signed status page, where an approved entry
is paid (`/register/status` → `POST /api/register/pay`). Registering never opens a checkout (it would
take a place): the app calls `POST /me/registrations/{id}/pay` right after, the web guest presses Pay on
the status page. App registration needs an account with a
confirmed email (anonymous / player-code accounts get `403 email_required`).

## 4. Environment

| Move Score | Move Tick | |
|---|---|---|
| `MOVE_TICK_API_URL` | — | Move Tick's base URL (https; http only on localhost) |
| `MOVE_TICK_PARTNER_KEY` | `MOVE_SCORE_PARTNER_KEY` | the bearer key (same value, 32+ characters) |
| `MOVE_TICK_WEBHOOK_SECRET` | `MOVE_SCORE_WEBHOOK_SECRET` | webhook HMAC secret (same value, 32+ characters) |
| `MOVE_TICK_MODE` | (XPay key prefix `sk_test_` / `sk_live_`) | `test` or `live`; must agree |
| — | `MOVE_SCORE_WEBHOOK_URL` | `https://tour.mbeg.org/api/webhooks/move-tick` |
| — | `MOVE_SCORE_RETURN_ORIGINS` | `https://tour.mbeg.org` |

Missing any of Move Score's three values: online payment is unavailable and every fee is paid at the
venue (the registration pages say so). Missing any of Move Tick's: the partner API answers `401`.

## 5. Deploy order

1. Move Tick: apply `20261069_partner_payment_sessions.sql` then `20261070_partner_one_open_session.sql` (one open session per reference; it first closes older duplicate open rows), set the four `MOVE_SCORE_*` variables, deploy (the branch's partner checkouts live 15 minutes, matching Move Score's place hold)
   the branch (after review), schedule `/api/cron/partner-webhooks` every 5 minutes (pg_cron + pg_net
   with the Vault `CRON_SECRET`, like `20261068`; the daily housekeeping cron retries too).
2. Move Score: apply `0028_registration.sql`, `0029_registration_hardening.sql` then
   `0030_registration_first_paid.sql` (after 0022–0027), set `MOVE_TICK_*` (with `MOVE_TICK_MODE=test`
   and Move Tick on an `sk_test_` key first), deploy.
3. Rehearse with a test card end to end (register → pay → webhook → confirmed → refund; and once in
   organiser mode: register → approve → pay), then switch both sides to live together
   (`MOVE_TICK_MODE=live`, `sk_live_`).

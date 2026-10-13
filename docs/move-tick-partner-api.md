# Move Tick partner API (Move Score registrations)

Move Score takes registrations; Move Tick takes the money. Players register for a tournament or a
friendly session in Move Score (the app, or the public web form at `/register/<slug>`); when the entry
fee is paid online, Move Score asks Move Tick for a hosted XPay checkout and Move Tick tells Move Score
what happened through signed webhooks. Move Score never sees a card, and Move Tick never decides who
may register or be refunded.

Online payment is offered **only for the Move Beyond organisation's events** (no payouts to other
organisations yet) and only while Move Tick is configured on the server. Everywhere else a fee is paid
at the venue. Plan: Phase 9; decisions: `DECISIONS.md` § 8.

- Move Score side: `src/lib/registration/` (`rules.ts` pure, `moveTick.ts` client, `signature.ts`,
  `server.ts`), webhook `src/app/api/webhooks/move-tick/route.ts`, migration `0028_registration.sql`,
  gate `npm run e2e:registration` (with a fake Move Tick inside the script).
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
  "expiresAt":   "…" | null,
  "testMode":    true | false           // XPay sk_test_ key
}
```

- **Idempotent** on `(partner, Idempotency-Key)`: a retry returns the same session; the same key with
  another reference or amount is `409 IDEMPOTENCY_KEY_REUSED`.
- A reference already paid is never charged again: `409 ORDER_ALREADY_PAID`.
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
`reconcile:<session>:<status>`), amount check included.

### Refund

```
POST /api/partner/v1/payment-sessions/{sessionId}/refund
{ "reference": "<registration id>", "amount": 50000, "reason": "…" }
→ 200 { "refundId": "re_…", "status": "refunded" }      // or "refund_pending" (then a webhook follows)
```

- Only the **organiser's refund action** in Move Score calls it (Admin → event → Registrations, admins
  signed in with their own account, typed confirmation, audited), and only until **24 hours before the
  event's start time** (`tournaments.starts_at`). Players can only *ask* for a refund.
- **Full refunds only** for now (XPay refunds a payment intent whole): an amount other than the
  session's is `422 PARTIAL_REFUND_UNSUPPORTED`. Move Score's "card fee kept on refunds" setting stays at
  0 % (the default) until partial refunds exist.
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
3. **Idempotency**: the event id is recorded in `move_tick_events` first; a replay answers
   `200 {"duplicate": true}` and changes nothing. Every status change is also conditional on the status
   it moves from, keyed by the **reference** (a fresh event id for an already-applied change does
   nothing either).
4. **Ownership**: the session id must be one Move Score created, for exactly that reference.
5. **Mode**: `testMode` must match Move Score's `MOVE_TICK_MODE` (a test-card payment never confirms a
   real entry).
6. **Amount**: `payment.succeeded` must carry exactly the amount and currency Move Score asked for;
   otherwise the payment is held as `needs_review` and the entry is not confirmed.

Effects: `payment.succeeded` → payment `paid`, registration `awaiting_payment → confirmed`, the entry is
made in the event and the registrant's own player row is linked to their account (paid after the entry
was cancelled or refused: kept as `needs_review` for the organiser to refund); `payment.failed` /
`payment.expired` → the checkout is closed (the player can pay again); `payment.refunded` → payment
`refunded`, registration `refunded`, the entry leaves the event (a team that already has matches stays,
for the organiser).

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
| `pending_approval` | waiting for the organiser (default approval mode: the organiser approves) |
| `awaiting_payment` | approved, online payment due (approval comes before payment) |
| `confirmed` | in the event (paid online, due at the venue, or free) |
| `refused` / `cancelled` | turned down by the organiser / withdrawn by the player before paying |
| `refunded` | paid online and refunded by the organiser |

| Payment (both sides) | |
|---|---|
| `created`/`creating` → `open` → `paid` → `refund_pending` → `refunded` | the happy path |
| `failed`, `expired` | closed unpaid; a new checkout can be made |
| `needs_review` | an amount that did not match, or a payment after the entry was cancelled: a person decides |

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

1. Move Tick: apply `20261069_partner_payment_sessions.sql`, set the four `MOVE_SCORE_*` variables, deploy
   the branch (after review), schedule `/api/cron/partner-webhooks` every 5 minutes (pg_cron + pg_net
   with the Vault `CRON_SECRET`, like `20261068`; the daily housekeeping cron retries too).
2. Move Score: apply `0028_registration.sql` (after 0022–0027), set `MOVE_TICK_*` (with
   `MOVE_TICK_MODE=test` and Move Tick on an `sk_test_` key first), deploy.
3. Rehearse with a test card end to end (register → approve → pay → webhook → refund), then switch both
   sides to live together (`MOVE_TICK_MODE=live`, `sk_live_`).

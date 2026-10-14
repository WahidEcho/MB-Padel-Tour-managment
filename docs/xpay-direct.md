# Registration payments directly through XPay

**Decision (owner, 14 Oct 2026):** Move Score takes registration payments **directly through XPay**, with its
own webhook endpoint, instead of through a Move Tick partner API. Reason: Move Tick's live ticket-payment code
does not change at all. Both apps share **one XPay account**; each has its own webhook endpoint (and signing
secret) in the XPay dashboard. XPay sends every event to every endpoint, and each app ignores sessions that are
not its own (Move Score: anything whose metadata is not `app: "move-score"` or that matches none of its payment
rows answers 200 and is dropped; Move Tick: a session matching none of its payment rows is logged and answered
200).

The Move Tick partner API (`docs/move-tick-partner-api.md`) still works as the alternative
(`PAYMENT_PROVIDER=move_tick`). Online payment stays **Move Beyond-only**; every other organisation's fees are
paid at the venue. Rules (holds, first paid first in, refunds): `DECISIONS.md` § 8.

## Code

- Client: `src/lib/payments/xpay.ts` (checkout create / retrieve / expire, full refunds, key mode).
- Webhook: `src/lib/payments/xpayWebhook.ts` (signature, event parsing), route `src/app/api/webhooks/xpay/route.ts`.
- Provider switch: `src/lib/payments/provider.ts`. Registration logic: `src/lib/registration/server.ts`
  (`startPayment`, `applyXpayEvent` → `applyPaymentEvent`, `reconcileOnline`, `refundPayment`, `expireStalePayments`).
- Migration: `supabase/migrations/0033_payment_provider.sql` (`provider = 'xpay'`, `intent_id`, `move_tick_events.provider`).
- Tests: `src/lib/payments/xpay.test.ts`; E2E `npm run e2e:registration` with `PAYMENT_PROVIDER=xpay` (fake XPay
  inside the script); manual demo `scripts/demo/fake-xpay.ts` + `scripts/demo/registration-demo.ts`.

## How a payment runs

1. **Pay** (app, or the web status page) → Move Score takes the 15-minute place hold (only while a place is
   free), writes a `registration_payments` row (`provider = 'xpay'`, the amount from the registration row, never
   from a client) and creates an XPay checkout session:
   - `POST https://api.xpay.app/checkout/sessions`, `Authorization: Bearer XPAY_SECRET_KEY`,
     `Idempotency-Key: movescore-checkout-<payment id>` (a retry gets the same session, never a second payable page);
   - one line item in **piastres** (`unitAmount` = the amount, EGP), `afterCompletion.redirect.url` = the signed
     status page, `metadata = { app: "move-score", registration_id, payment_id }`;
   - `expiresAfterMinutes: 30` (XPay's minimum; resent without it if XPay refuses the parameter);
   - `paymentMethodTypes` only when `XPAY_PAYMENT_METHOD_TYPES` is set.
2. The payer pays on XPay's page; Move Score never sees a card.
3. XPay → `POST /api/webhooks/xpay` (signed). Move Score acts on `paymentStatus`, never on the event type alone:
   - `checkout.session.completed` with `paymentStatus: paid` (cards, ValU) → paid → the entry is confirmed
     (amount and currency re-checked against the payment row; a different or missing amount is held for review
     and the organisation's admins are emailed);
   - `checkout.session.completed` with `paymentStatus: unpaid` → a reference to pay later (Fawry-style): nothing
     changes, the entry keeps waiting;
   - `checkout.session.async_payment_succeeded` (paid) → paid; `checkout.session.async_payment_failed` → failed
     (the place goes back, the player is told nothing was charged);
   - `checkout.session.expired` → expired (the place goes back).
   Each event id is applied once (`move_tick_events`, stored as `xpay:<id>`); every change is conditional on the
   status it moves from. A payment that lands after its hold ran out is confirmed only while a place is free;
   otherwise it is flagged "payment to refund" (refundable in full at any time).
4. **The 15-minute hold ends the page.** XPay's own page lives 30 minutes, so Move Score closes it itself: when
   the player presses Pay again, and in the every-minute cron (`/api/internal/messages/drain`). It first reads
   the session: a paid page is applied as paid; a page a card is still completing on (3-D Secure, processing) or a
   completed unpaid reference is **never** closed from under the payer; otherwise
   `POST /checkout/sessions/{id}/expire`, and only a page XPay reports `expired` is marked expired here.
5. **Reconciliation**: the status page and "My registrations" ask XPay (`GET /checkout/sessions/{id}`) at most once
   per 30 seconds per payment, so a lost webhook never leaves a paid entry unconfirmed.
6. **Refunds** (the organiser, audited, always in full): `POST /refunds { paymentIntentId }` with
   `Idempotency-Key: movescore-refund-full-<payment id>` (XPay has no refund de-duplication of its own). No amount
   is sent: XPay refunds the whole intent. The intent id is stored when the payment lands (or read from the session).
   XPay accepting the refund marks it refunded at once (as Move Tick does with XPay); a `failed`/`canceled` answer
   is shown to the organiser as "XPay did not take the refund".
7. **Card minimum EGP 50**: a fee below it cannot be set to online (the settings say so), is never offered online,
   and is never sent to XPay.
8. **Mode**: `sk_test_` key = test, `sk_live_` = live; any other value counts as not configured (fail closed). Each
   payment row records its mode; an event whose `livemode` (when XPay sends it) or whose payment's mode disagrees
   with the server's key changes nothing.

## Owner setup (XPay dashboard + Vercel)

Do these in **Test mode** first, then repeat in Live mode (section "Going live").

1. **Apply migration `0033_payment_provider.sql`** to the live project (SQL editor) **before** deploying this
   branch: the server writes `provider = 'xpay'` and `intent_id`, which the old check refuses. It is additive and
   safe to apply ahead of the deploy.
2. **XPay dashboard → Webhooks → Add endpoint** (Test mode):
   - URL: `https://tour.mbeg.org/api/webhooks/xpay`
   - Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
     `checkout.session.async_payment_failed`, `checkout.session.expired`. (No refund events are needed: Move Score
     records a refund from XPay's answer to its own refund request. Anything else that arrives is answered 200 and
     ignored.)
   - Copy this endpoint's **signing secret** (`whsec_…`). It is not Move Tick's secret: Move Tick's endpoint keeps
     its own.
3. **Vercel → Move Score project → Settings → Environment Variables** (Production; Preview too if you test there):
   - `XPAY_SECRET_KEY` = the **same** XPay secret key Move Tick uses (start with `sk_test_…`);
   - `XPAY_WEBHOOK_SECRET` = the signing secret from step 2;
   - `PAYMENT_PROVIDER` = `xpay`;
   - optional `XPAY_PAYMENT_METHOD_TYPES` = `card,valu` (as Move Tick's tickets, decision D6: no Fawry, whose
     reference is paid hours later while the 15-minute place hold is long gone; a reference paid later still lands,
     and is confirmed only if a place is free, otherwise flagged for a full refund). Every type listed must be
     enabled on the XPay account in that mode, or XPay refuses every checkout; unset = the account's defaults.
   - The `MOVE_TICK_*` variables can stay or go; with `PAYMENT_PROVIDER=xpay` they only serve payments Move Tick
     already took (none on production so far).
4. **Redeploy** (env changes need a new deployment).
5. **Test with a test card** on a Move Beyond event whose fee is at least EGP 50, payment "Online":
   register (app or web), press Pay, and on XPay's page use the test card from XPay's quickstart
   `5123 4500 0000 0008`, expiry `01/39`, CVV `100` (as in Move Tick's `docs/XPAY_SETUP.md`). Expect: back on the
   status page, **Confirmed**; Admin → Registrations shows "EGP … online — paid"; XPay dashboard → Webhooks → the
   endpoint shows the delivery answered `200`. Then refund it from Admin → Registrations (type REFUND): the XPay
   dashboard shows the refund. Also check a page left open: after 15 minutes the place frees up and the page is
   expired at XPay within a minute (the cron).

## Going live

1. In XPay **Live mode**, add the same endpoint (`https://tour.mbeg.org/api/webhooks/xpay`, the same four events)
   and copy its live signing secret.
2. In Vercel set `XPAY_SECRET_KEY` = `sk_live_…` and `XPAY_WEBHOOK_SECRET` = the live endpoint's secret; redeploy.
   If `XPAY_PAYMENT_METHOD_TYPES` is set, check those methods are enabled in Live mode too.
3. One small real payment and a refund, before announcing the event.

Test-mode payments are never confirmed by a live server (and the other way round): each row keeps its mode.

## Turning it off / back

- `PAYMENT_PROVIDER=move_tick` (with the `MOVE_TICK_*` variables, once Move Tick's partner API is deployed), or
  remove `XPAY_SECRET_KEY` / `PAYMENT_PROVIDER`: online payment becomes unavailable and fees are paid at the venue.
- Payments already taken stay with their provider: their webhooks, reconciliation and refunds keep going to XPay
  as long as `XPAY_SECRET_KEY` and `XPAY_WEBHOOK_SECRET` stay set.

## What was not confirmed against XPay itself

The integration follows Move Tick's (checked against docs.xpay.app and the sandbox to the 3-D Secure screen,
Move Tick `PROJECT_FINALIZATION_QA.md`). Not yet seen on a real XPay account by Move Score:

- the `checkout.session.expired` event name and payload (Move Tick's partner branch handles it the same way);
- the `livemode` flag on events (checked only when present) and the `cs_test_` / `cs_live_` session-id prefix
  (checked only when present);
- `POST /checkout/sessions/{id}/expire` and `expiresAfterMinutes` (from Move Tick's partner branch; a refused
  `expiresAfterMinutes` is retried without it);
- the refund answer's `status` values (`failed` / `canceled` are treated as refused; anything else as done) and
  whether XPay sends refund events (not subscribed; a refund made by hand in the XPay dashboard is **not** seen by
  Move Score: refund from Admin → Registrations instead);
- the test card above (from Move Tick's notes on XPay's quickstart).

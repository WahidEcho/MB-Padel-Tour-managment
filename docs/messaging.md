# Messaging: email (Resend) and WhatsApp (Cloud API)

Admin → **Announcements** sends a message to players by email and/or WhatsApp (and app push to Move Score
users) and tracks every recipient: sent, delivered, read/opened, failed (with the reason), bounced, spam
complaint, "Not on WhatsApp", or not sent (no address, invalid number, opted out, no access code).

## What is where

| | |
|---|---|
| `src/lib/messaging/` | `phone.ts` (E.164, Egypt default), `email.ts` (Resend REST + Svix webhook check), `whatsapp.ts` (Graph API templates/text, error codes, webhook parsing, X-Hub-Signature-256), `render.ts` (merge fields, branded HTML + text email), `templates.ts` (template variable mapping, transactional catalogue), `recipients.ts` (who gets what, and why not), `status.ts` (forward-only statuses, funnel counts), `transport.ts` (the only network sender; dry-run mode), `queue.ts` (enqueue, drain, retry, webhooks, `sendTransactional`), `audience.ts` (DB audiences), `data.ts` (console reads). Pure parts are covered by `messaging.test.ts`. |
| `supabase/migrations/0020_messaging.sql` | `message_announcements`, `message_deliveries`, `whatsapp_contacts`, view `message_delivery_stats`; `players.access_code` (defensive, also added by 0018). |
| `src/app/admin/announcements/` | List, compose (`new`, presets `?preset=access_codes` / `?preset=new_tournament&tournament=<id>`), detail with filters, Retry failed, Stop sending, `…/export` CSV. The tournament dashboard has a "Tell the players" card. |
| `src/app/api/webhooks/resend`, `src/app/api/webhooks/whatsapp` | Provider status webhooks. |
| `src/app/api/internal/messages/drain` | Chunked sender for the cron job (`CRON_SECRET`). |
| `supabase/ops/messaging_cron.sql` | pg_cron job `movescore-drain-messages` (every minute). |

The existing in-app `announcements` table (Move Score feed) is untouched; an announcement sent with the
**App push** channel to a tournament's players also writes a row there and alerts its followers; to a
nation it alerts that nation's followers; to "App users" every phone with announcements switched on.

## How sending works

1. **Send** (after a confirmation) inserts the announcement, flips it draft → sending once (a second click
   cannot enqueue twice), resolves the audience, and writes one `message_deliveries` row per person per
   channel: `queued`, or `skipped` with the reason. A person listed twice (same address) gets one message.
2. A **drain** sends queued rows in time-boxed chunks (≈15–40 s): email through Resend's batch endpoint
   (100 per request, one request every 550 ms), WhatsApp 8 at a time. Rows are claimed queued → sending with
   a compare-and-set, so concurrent drains never double-send. It runs right after Send (`after()`), in a loop
   from the detail page while it is open, and every minute from the cron job — so a long send never depends
   on one Vercel function.
3. Transient errors (rate limits, provider down) go back to the queue, up to 5 attempts. Permanent ones are
   `failed` with code and a human reason. A drain that dies mid-send leaves rows `sending`; they are
   re-queued after 5 minutes (a person may then rarely get a message twice, never none).
4. **Webhooks** move rows forward only (sent → delivered → read; failed/bounced/complained are never masked
   by a late "sent"). Emails are matched by Resend's id or the `delivery` tag; WhatsApp by `wamid`.
5. **Retry failed** re-queues failed rows except bounces, "not sent" rows and WhatsApp 131026 (not on
   WhatsApp) / 131050 (stopped marketing messages), which another try cannot fix.

Audiences: all players (profiles approved or pending, not merged/rejected), a tournament's players, a
nation's players (teams with that nation code), app users (push only), a pasted list
(`name, email, phone` per line). For a tournament's or nation's players the contact is the player's own
`players.phone` / `players.email` (set on the Player codes page or by the player in the app), else their
platform profile's, else the team's contact phone; the preview says which source each came from. "All
players" uses `player_profiles` (email, mobile). A `player_consents` row with `granted = false`
for email/WhatsApp is honoured ("The player has not agreed to this channel"). A WhatsApp number that sends
**STOP** (or إلغاء / توقف) is opted out (`whatsapp_contacts`); **START** opts back in.

Merge fields: `{name}`, `{first_name}`, `{code}` (players.access_code), `{tournament}`, `{link}` (tournament
page), `{app_link}` (`/movescore`). Links use `PUBLIC_SITE_URL` (default `https://mb-tournament.vercel.app`).

### Transactional messages

```ts
import { sendTransactional } from "@/lib/messaging/queue";
await sendTransactional({
  to: "+201001234567" /* or an email */, channel: "whatsapp", template: "confirmation",
  vars: { name: "Omar Khaled", title: "Registration received", message: "We have your entry for the Spring Open." },
  idempotencyKey: `registration:${entryId}`, // same key → no second send, returns the first result
  recipient: { kind: "player_profile", id: profileId },
});
```

Templates: `access_code`, `confirmation`, `new_tournament`, `announcement` (`src/lib/messaging/templates.ts`).
Email works immediately. WhatsApp sends free-form text when the person wrote to us in the last 24 hours,
otherwise the matching approved template below. Every call is logged in `message_deliveries`
(`announcement_id` null, `purpose` = template name).

## Environment variables (Vercel → Project → Settings → Environment Variables)

Same names as Move-Tick. Values are in `~/MoveScore-keys/messaging-secrets.env` (copied from Move-Tick).

| Name | What |
|---|---|
| `RESEND_API_KEY` | Resend API key with sending access. |
| `RESEND_FROM_EMAIL` | Sender address on a **verified Resend domain** (mbeg.org is verified for Move-Tick; e.g. `tournaments@mbeg.org`). Move-Tick's value is `movetick@mbeg.org`. |
| `RESEND_FROM_NAME` | Sender name. Move-Tick uses "Move Tick"; for this platform set **Move Beyond**. |
| `RESEND_WEBHOOK_SECRET` | Signing secret (`whsec_…`) **of the webhook endpoint you create for this platform** in Resend. Each Resend endpoint has its own secret: the one copied from Move-Tick verifies Move-Tick's endpoint only, so replace it after registering ours. |
| `WA_CLOUD_ACCESS_TOKEN` | System-user token with `whatsapp_business_messaging` + `whatsapp_business_management`. |
| `WA_CLOUD_PHONE_NUMBER_ID` | Sending phone number id. |
| `WA_CLOUD_WABA_ID` | WhatsApp Business Account id (template list in the composer). |
| `WA_CLOUD_NUMBER` | The number itself (informational). |
| `WA_CLOUD_API_VERSION` | Graph API version, `v21.0`. |
| `WA_CLOUD_APP_SECRET` | Meta app secret (verifies `X-Hub-Signature-256`). Note: the main checkout's `.env.local` has a different, non-hex value for this name; the 32-hex value from Move-Tick is the one in the secrets file. |
| `WA_CLOUD_VERIFY_TOKEN` | Any string; must equal the "Verify token" typed in Meta's webhook settings. |
| `CRON_SECRET` | Already used by the notification drain; the messaging cron uses the same vault secret. |
| `PUBLIC_SITE_URL` | Optional; links in messages. Default `https://mb-tournament.vercel.app`. |
| `MESSAGING_DRY_RUN` | `1` = nothing leaves the server (stand-in, tests). Never set in production. |

## Webhooks to register

- **Resend** → Webhooks → Add endpoint `https://mb-tournament.vercel.app/api/webhooks/resend`, events
  `email.sent`, `email.delivered`, `email.bounced`, `email.complained`, `email.opened`, `email.clicked`,
  `email.failed`. Put that endpoint's signing secret into `RESEND_WEBHOOK_SECRET`. The account is shared
  with Move-Tick: each endpoint receives every email's events, and ours ignores ones it did not send.
- **WhatsApp** → Meta App Dashboard → WhatsApp → Configuration → Callback URL
  `https://mb-tournament.vercel.app/api/webhooks/whatsapp`, verify token = `WA_CLOUD_VERIFY_TOKEN`,
  subscribe to `messages`.
  **Important:** a Meta app has one WhatsApp callback URL, and Move-Tick's bridge is registered today on the
  same app and phone number. Pointing it here would cut Move-Tick's delivery reports. Options: (a) a second
  phone number on the WABA with a phone-number-level webhook override pointing here (cleanest), (b) have
  the Move-Tick bridge forward the raw body + `X-Hub-Signature-256` header of webhooks it does not
  recognise to this URL (the signature stays valid since the body is unchanged), or (c) a separate Meta
  app. Until one is done, WhatsApp rows stop at "sent" (sending works; delivered/read/"not on WhatsApp"
  are not reported).

Then, once per project, after migration 0020: run `supabase/ops/messaging_cron.sql` (replace `<SITE>`).

## Resend domain requirement

`RESEND_FROM_EMAIL` must be on a domain verified in Resend (SPF/DKIM DNS records under Resend → Domains),
otherwise every send fails with 403 ("Sender not allowed — verify the RESEND_FROM_EMAIL domain"). mbeg.org
is already used by Move-Tick; if a new subdomain is used (e.g. `mail.mbeg.org`), add and verify it first.

## WhatsApp templates

Business-initiated WhatsApp messages must be **approved templates**. Templates on the WABA today
(read-only listing, 3 Oct 2026):

| Name | Lang | Category | Use here |
|---|---|---|---|
| `movetick_event_invitation` | en_US | Marketing | Move-Tick ticket (image header, wallet button) — not for players |
| `padel_corporate_invite` | en_US | Marketing | Corporate padel invite with QR image header — not general |
| `hello_world` | en_US | Utility | Meta sample, fine for "Send test" |
| `3p_direct_integration_test_template` | en_US | Utility | Meta sample |

None fits announcements, codes or confirmations. Submit these (WhatsApp Manager → Message templates →
Create; language **English (en)**; variables cannot contain line breaks — the sender flattens them to " · "):

1. **`mb_announcement`** — Marketing
   Body: `Hi {{1}}, here is an update from Move Beyond: *{{2}}* {{3}} Reply STOP to stop these messages.`
   Samples: `Omar` / `Court change tonight` / `Matches at the Spring Open move to court 3 from 7 pm.`
   Footer: `Move Beyond`. Composer mapping: first name, title, message.
2. **`mb_new_tournament`** — Marketing
   Body: `Hi {{1}}, registration is open for {{2}} 🎾 {{3}} See the dates and sign up: {{4}}`
   Samples: `Omar` / `Spring Padel Open` / `Three days of padel at Smash Club, 12–14 Nov.` /
   `https://mb-tournament.vercel.app/t/spring-open`. Optional IMAGE header (poster). Mapping: first name,
   tournament, message, link.
3. **`mb_access_code`** — Utility
   Body: `Hi {{1}}, your Move Score player code is {{2}}. Get the app, sign in, open Account, tap Player code and enter it. Get the app: {{3}} Keep this code private.`
   Samples: `Omar` / `MB7Q2K` / `https://mb-tournament.vercel.app/movescore`. Mapping: first name, code, app
   link. (Meta may recategorise code messages as Authentication; if so, keep Utility wording about linking
   matches, not logging in.)
4. **`mb_confirmation`** — Utility
   Body: `Hi {{1}}, this is a confirmation from Move Beyond: {{2}} If anything looks wrong, reply to this message.`
   Samples: `Omar` / `we have received your registration for the Spring Padel Open.` Used by
   `sendTransactional` (`confirmation`).

Marketing templates need recipients who agreed to hear from us and are limited by Meta per person
(error 131049 "held back"); Utility is for messages a person expects. Until they are approved, WhatsApp
sends of these names fail with 132001 (shown on each row); email works meanwhile.

WhatsApp failure reasons shown in the console include 131026 *Not on WhatsApp / undeliverable*, 131047
*outside the 24-hour window*, 131049 *held back by Meta*, 131050 *stopped marketing messages*, 132000/132001
template problems, 130429 throughput (retried), 190 token expired (full table in `whatsapp.ts`).

## Checks

- Unit: `npx vitest run src/lib/messaging`.
- End to end on the stand-in, dry run (nothing is sent): create `.env.e2e-messaging` from `.env.localdb`
  with `SUPABASE_URL=http://localhost:54338`, `BASE_URL=http://localhost:3088`, `MESSAGING_DRY_RUN=1`,
  and test-only `RESEND_WEBHOOK_SECRET` (`whsec_<base64>`), `WA_CLOUD_APP_SECRET`, `WA_CLOUD_VERIFY_TOKEN`;
  start `LOCALDB_PORT=54338 npm run localdb` and `next dev -p 3088` with that same environment, then
  `npm run e2e:messaging`.

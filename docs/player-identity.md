# Player identity and history (Phase 1)

One person = one `player_profiles` row whose `auth_user_id` is their Move Score account. The account
sees and edits the per-tournament `players` rows it holds in `player_claims` (one account per row).
Migration: `supabase/migrations/0024_player_identity.sql`. Code: `src/lib/players/` (`link.ts`,
`codeVault.ts`, `otp.ts`, `phoneLink.ts`, `suggestions.ts`, `profile.ts`, `merge.ts`).

## Ways in

| Way | Route (app) | Proves | Links |
|---|---|---|---|
| Player code (any code, valid until reset) | `POST /me/player/claim`, or `POST /auth/player-code` (signs in without an account) | the code the organisation sent | that row, and the same person's rows (identity rule) **in the same organisation** |
| Phone one-time code | `POST /me/player/phone/{start,email,verify,choose}` | the player controls the phone | rows recorded with that phone, or whose profile has that mobile, in any organisation; when several people share the phone (a parent's number) the player picks who they are |
| Email match | `GET/POST /me/player/suggestions` | the account's confirmed email, and the player said "That's me" | rows recorded with that email, or whose profile has it |
| Organiser offer | Admin → Players → "Link to app account"; the player confirms in the app (same suggestions route) | the organisation vouches the account email is its player, and the player said yes | that organisation's rows of the profile |

Nothing links an organisation's rows from another organisation's data: an organisation can type any name,
phone or email on its own rows, so a code's sibling rows stay inside the code's organisation, and rows in
other organisations come only through a phone code, a confirmed email, or the player's own yes.

The profile a link lands on: the account's own if it has one; else the row's profile when the proof
reaches it (a code from an organisation that vouches for the profile, i.e. it created or added the player
or is alone with them; a phone or email that is the profile's own; an organiser's offer); else a new
profile made from the row (name, phone in E.164 via `toE164` with `normalizeMobile` as fallback, email).
A new profile never takes an existing profile's mobile number — only a phone code proves that number. Rows
without a profile join the account's profile. A code from an organisation that only *matched* a profile
(a mobile typed on its public form) links that row but not the profile. A profile already linked to another
account is refused ("Ask the tournament desk"). The account's profile rows in organisations that vouch for
the profile are picked up again on every `GET /me/player` / `GET /me/profile` (a new tournament entry shows
up on its own).

### Organisations: the confirmed link

`organization_players.source = 'link'` is set only when the player, in **My profile → Organisations**,
shares their details with an organisation that had only matched them (`POST /me/profile/share`). That is
what unmasks the profile's person fields for it (`src/lib/orgs/personFields.ts`). An organisation whose row
joins an existing profile through a link gets the player as `matched` (it sees the name it typed) until the
player shares; a profile made from an organisation's own row is that organisation's (`tournament`).

### Phone codes

6 digits, 10 minutes, 5 attempts (counted before the compare, compare-and-set), one use, compared in
constant time against `HMAC(PLAYER_CODE_PEPPER, "mb-phone-otp:v1:<verification id>:<code>")`
(`phone_verifications.code_hash`). Limits: 3 per phone per 15 minutes and 8 per day (phone keys are
hashed), 5 per account per 15 minutes and 15 per day, 30 per network address per hour; verify 60 per address
per hour; email fallback 3 per account per hour. The start answer is the same whether or not any entry has
the number. If WhatsApp does not take the code (or never arrives), the app **asks** "Send it by email
instead?"; only after yes (`consent: true`) a new code goes to the email addresses organisers recorded
with that phone, with the same answer whether or not one was on file. Verifications older than a day are
deleted by the messaging cron.

WhatsApp uses the authentication template `mb_login_code` (definition and submission steps in
`docs/messaging.md`); until `WA_OTP_TEMPLATE` is set the server answers `sent: false` and the app offers
email. Delivery rows never hold a code.

## Player codes at rest

Codes used for sign-in and claims are looked up by `players.access_code_hash` =
`HMAC-SHA256(PLAYER_CODE_PEPPER, "mb-player-code:v1:" + code)`. The pepper lives only in the server's
environment, so the migration cannot compute it: rows written before 0024, and new rows that take the
column default `gen_player_access_code()`, keep the plain code in `players.access_code` until the server
hashes them — on first use (claim, sign-in), every minute in the messaging cron (`codesHashed` in its
answer), and all at once with `scripts/ops/hash-player-codes.ts`. Hashing a row also stores the code
**sealed** (AES-256-GCM, key derived from the same pepper) in `players.access_code_sealed` and clears the
plain column.

**Decision — resend keeps the same code.** The organiser still shows, copies, prints (CSV) and sends each
player's code (Player codes page, "Send code", the "access codes" announcement): the server opens the sealed
copy for that page or message only. A copy of the database alone yields neither working codes nor sealed
ones without the pepper. "Reset code" still issues a new code and unlinks the account, as before. Sends:
"Send code" logs the message with the code replaced by `[removed]` (`redact`, `secretOnWhatsApp`), and the
announcement queue stores `code_ref` instead of the code (`docs/messaging.md`).

## My profile (app)

`GET /me/profile` (`MMyProfile`): tournaments (with organisation and record), sessions and nights (the
friendly ledger: played, points), upcoming matches and results, totals, the player's own phone and whether
it was confirmed, and the organisations with their sharing state. Leagues, league points and ranks are
listed in `comingSoon` until Phase 7 — no sample data. App screens: `move-score-app/src/app/profile.tsx`,
`link-phone.tsx`, the "Is this you?" cards in `src/player/PlayerSection.tsx`.

## Merging profiles (platform admins)

Admin → Players → Merge (platform admins only). Refused when the two profiles are linked to different
accounts (one must unlink in the app, or have their codes reset). Otherwise the survivor takes the absorbed
profile's account, its mobile and email when it has none, the consents it has no answer for, its ranking
categories, its open link offers, and its place in every organisation (anything but `matched` beats
`matched`; categories are combined) — `src/lib/players/merge.ts`, after `mergePlayerProfiles`.

## Environment

- `PLAYER_CODE_PEPPER` (32+ random characters, **not** the same as `EVENT_CODE_PEPPER`, never in the
  database). Required in production: without it player codes and phone codes answer "not available" (503).
  Changing it voids every hashed code and every sealed copy (reset all codes to recover). Outside production
  it is derived from `AUTH_SECRET` when unset; the stand-in's `.env.localdb` sets it so the E2E scripts and
  the server agree.
- `WA_OTP_TEMPLATE`, `WA_OTP_TEMPLATE_LANG` (`docs/messaging.md`).

## Deploy order

1. Phase 0.5 deployed (gate closed, 0023 applied).
2. Set `PLAYER_CODE_PEPPER` in Vercel (Production and Preview) **before** the deploy: the new code refuses
   player-code sign-in without it.
3. Apply `0024_player_identity.sql` to the live project (additive; columns, indexes and two private tables).
4. Deploy.
5. Run once, with the production pepper and the secret key:
   `PLAYER_CODE_PEPPER=… SUPABASE_URL=… SUPABASE_KEY=<secret> npx tsx scripts/ops/hash-player-codes.ts`
   (`--dry-run` first prints the counts). The cron keeps new players hashed from then on.
6. Submit the `mb_login_code` authentication template; once approved, set `WA_OTP_TEMPLATE` (and the
   language) and redeploy. Until then phone codes go by email after the player agrees.

## Checks

- `npx vitest run src/lib/players` (hashing, sealing, one-time codes, the source rules).
- Stand-in: `scripts/e2e/mobile-api.ts` (codes hashed after use, profile made at link time, phone code with a
  shared parent phone, WhatsApp failing → ask → email, email match, organiser offer, another organisation
  cannot offer a link for this one's player, sharing unmasks, merge rules, the anonymous player-code
  sign-in); `scripts/e2e/organizations.ts` (the offer actions in the cross-organisation attack list);
  `scripts/e2e/messaging.ts` (no code on any delivery row; the cron hashes plain codes).
  The scripts read one-time codes back from their hashes (they have the pepper), never from a message.

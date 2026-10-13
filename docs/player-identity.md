# Player identity and history (Phase 1)

One person = one `player_profiles` row whose `auth_user_id` is their Move Score account. The account
sees and edits the per-tournament `players` rows it holds in `player_claims` (one account per row).
Migrations: `supabase/migrations/0024_player_identity.sql`, and the security review's
`0026_identity_hardening.sql`. Code: `src/lib/players/` (`link.ts`, `codeVault.ts`, `otp.ts`, `phoneLink.ts`,
`suggestions.ts`, `profile.ts`, `merge.ts`).

## Ways in

| Way | Route (app) | Proves | Links |
|---|---|---|---|
| Player code (any code, valid until reset) | `POST /me/player/claim`, or `POST /auth/player-code` (signs in without an account) | the code the organisation sent | that row, and the same person's rows (identity rule) **in the same organisation** |
| Phone one-time code (WhatsApp) | `POST /me/player/phone/{start,verify,choose}` | the player controls the phone | rows recorded with that phone, or whose profile has that mobile, in any organisation; when several people share the phone (a parent's number) the player picks who they are |
| Phone code by email (fallback) | `POST /me/player/phone/email` then `verify` | the account's own confirmed email only (never the phone) | only rows recorded with **both** that phone and that email; the number is not marked confirmed |
| Email match | `GET/POST /me/player/suggestions` | the account's confirmed email, and the player said "That's me" | rows recorded with that email; rows of a profile with that email only in organisations that vouch for the profile |
| Organiser offer | Admin → Players → "Link to app account" (only for a player the organisation added itself, never one it only matched); the player confirms in the app (same suggestions route) | the organisation vouches the account email is its player, and the player said yes | that organisation's rows of the profile, and nothing of other organisations' (see below) |

Nothing links an organisation's rows from another organisation's data: an organisation can type any name,
phone or email on its own rows, so a code's sibling rows stay inside the code's organisation, and rows in
other organisations come only through a phone code, a confirmed email, or the player's own yes.

The profile a link lands on: the account's own if it has one; else the row's profile when the proof
reaches it (a code from an organisation that vouches for the profile, i.e. it created or added the player
or is alone with them; a phone or email that is the profile's own, or — when the profile has no mobile /
no email at all — a row of an organisation that vouches for it; an organiser's offer from an organisation
that added the player); else, when the rows have no profile, a new profile made from the row (name, email,
and a mobile: the number a phone code proved, or for a code the row's phone in E.164 via `toE164` with
`normalizeMobile` as fallback; an email proof puts no mobile on it). Rows on a profile the proof does not reach
(another person's contact on it, an organisation that only matched it) link **without** the profile: an
organisation that types the attacker's email on a row matched to someone's profile hands over that row, not
the person.
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

### Offers reach one organisation

An account that comes to speak for a profile through an offer has only that organisation's word for it:
`player_profiles.owner_scope_org` records the organisation, and from then on the profile's rows are
picked up only in that organisation (and in organisations where the account holds an entry by its own
proof), and `/me/profile` shows only those organisations' sessions. A phone code to the profile's own
mobile, or a link by the profile's own email, clears it. Unlinking clears it; a merge carries it with
the account.

### Phone codes

6 digits, 10 minutes, 5 attempts (counted before the compare, compare-and-set), one use, compared in
constant time against `HMAC(PLAYER_CODE_PEPPER, "mb-phone-otp:v1:<verification id>:<code>")`
(`phone_verifications.code_hash`). Limits, all counted atomically before the work (`takeRateLimit`): 3 per
phone per 15 minutes and 8 per day (phone keys are hashed), 5 per account per 15 minutes and 15 per day, 30
per network address per hour; at most **2 codes open at once per phone** across every account (a burst of
starts keeps the oldest two); **10 wrong guesses per phone per day** across every verification and account (a
right code is given back; after that the number answers "try tomorrow", and the player can still use a player
code); verify 60 per address per hour; email fallback 3 per account per hour. Two starts at once by one account
leave only the newest open. The start answer is the same whether or not any entry has the number.

If WhatsApp does not take the code (or never arrives), the app **asks** "Send it to <your email> instead?";
only after yes (`consent: true`) a new code goes to **the account's own confirmed email**, and only when an
organiser recorded that address with the phone (on an entry with that phone, or on the profile whose mobile it
is). Never to any other address on file: an address an organiser typed proves nothing about who owns the
phone. The answer is the same whether or not it was on file, and the email is sent after the answer
(`after()`), so timing says nothing either. A keyed hash of the address is kept on the verification
(`email_hash`); `verify` then links only entries recorded with **both** that phone and that address (never a
profile's other rows, never another organisation's rows through a profile), takes a profile only when the
address is the profile's own, and never sets `phone_verified_at` (the answer says `confirmed: "email"`). An
anonymous (player-code) account has no confirmed email: the email step answers `no_email`. Verifications older
than a day are deleted by the messaging cron.

The number a player types in the app (`PATCH /me/player`, "Phone, only the organisers see it") is stored in
`players.self_reported_phone`, never in `players.phone`: the organiser's Player codes page shows it as "not
checked", and nothing looks entries up by it. `players.phone` is written by organisers only. `PATCH /me/player`
and `POST /me/player/claim` refuse unknown fields (400), like every player-linking route.

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
announcement queue stores `code_ref` instead of the code (`docs/messaging.md`); the drain reads codes only
through `code_ref`. A code never goes to a **team's contact number** (often a partner's or a captain's):
"Send code" refuses, an access-codes announcement records it as not sent (`team_contact`), and any other
announcement to a team number goes without the code.

Rows logged before this (old "Send code" rows: `vars.code`, the rendered message and the idempotency key
`player-code:<player>:<channel>:<CODE>:<minute>`; old announcement rows: `vars.code`) are cleaned once by
`scripts/ops/scrub-delivery-codes.ts` (see Deploy order).

## My profile (app)

`GET /me/profile` (`MMyProfile`): tournaments (with organisation and record), sessions and nights (the
friendly ledger: played, points), upcoming matches and results, totals, the player's own phone and whether
it was confirmed, and the organisations with their sharing state. Leagues, league points and ranks are
listed in `comingSoon` until Phase 7 — no sample data. App screens: `move-score-app/src/app/profile.tsx`,
`link-phone.tsx`, the "Is this you?" cards in `src/player/PlayerSection.tsx`.

## Merging profiles (platform admins)

Admin → Players → Merge (platform admins only). Refused when the two profiles are linked to different
accounts, counting the profile's own account **and every account holding one of its entries**
(`player_claims`) (one must unlink in the app, or have their codes reset). Otherwise the survivor takes the absorbed
profile's account, its mobile and email when it has none, the consents it has no answer for, its ranking
categories, its open link offers, and its place in every organisation (anything but `matched` beats
`matched`; categories are combined) — `src/lib/players/merge.ts`, after `mergePlayerProfiles`.

## Environment

- `PLAYER_CODE_PEPPER` (32+ random characters, **not** the same as `EVENT_CODE_PEPPER`, never in the
  database). Required in production: without it player codes and phone codes answer "not available" (503).
  Changing it voids every hashed code and every sealed copy (reset all codes to recover). Outside production
  it is derived from `AUTH_SECRET` when unset, **but only when `SUPABASE_URL` is local** (localhost,
  127.0.0.1, ::1) or unset: a development run pointed at the real project without the pepper refuses codes
  rather than hashing them, irreversibly, under the wrong pepper. The stand-in's `.env.localdb` sets it so the
  E2E scripts and the server agree.
- `WA_OTP_TEMPLATE`, `WA_OTP_TEMPLATE_LANG` (`docs/messaging.md`).

## Deploy order

1. Phase 0.5 deployed (gate closed, 0023 applied).
2. Set `PLAYER_CODE_PEPPER` in Vercel (Production and Preview) **before** the deploy: the new code refuses
   player-code sign-in without it.
3. Apply `0024_player_identity.sql`, then `0026_identity_hardening.sql`, to the live project (both additive:
   columns, indexes, two private tables). 0026 must be on before the deploy: the code reads
   `players.self_reported_phone`, `phone_verifications.email_hash` and `player_profiles.owner_scope_org`.
   (0025 is the organisations hardening; the leagues migration is `0027_leagues.sql`, Phase 7.)
4. Deploy.
5. Run once, with the production pepper and the secret key:
   `PLAYER_CODE_PEPPER=… SUPABASE_URL=… SUPABASE_KEY=<secret> npx tsx scripts/ops/hash-player-codes.ts --dry-run`
   (counts only), then without `--dry-run`. Before writing it opens a code the deployed server already sealed
   and refuses when the pepper does not reproduce it; when nothing is sealed yet (no player used a code since
   the deploy) it refuses unless `--first-run` is passed on purpose. After hashing it scrubs the message log
   (step 6). The cron keeps new players hashed from then on.
6. The message log on its own (step 5 runs it too; safe to repeat):
   `SUPABASE_URL=… SUPABASE_KEY=<secret> npx tsx scripts/ops/scrub-delivery-codes.ts` prints counts (a dry run
   by default); `--apply` removes the codes from `vars`, stored messages and idempotency keys of old rows.
7. Submit the `mb_login_code` authentication template; once approved, set `WA_OTP_TEMPLATE` (and the
   language) and redeploy. Until then a phone code can only go by email, to an account whose own email the
   organiser recorded with that phone; everyone else links with their player code.

## Checks

- `npx vitest run src/lib/players` (hashing, sealing, one-time codes, the source rules; `hardening.test.ts`:
  the local-only derived pepper, 16-byte seal tags, scrubbing old delivery rows, no code to a team number,
  strict bodies).
- Stand-in: `scripts/e2e/mobile-api.ts` (codes hashed after use, profile made at link time, phone code with a
  shared parent phone, WhatsApp failing → ask → email, email match, organiser offer, another organisation
  cannot offer a link for this one's player, sharing unmasks, merge rules, the anonymous player-code
  sign-in); `scripts/e2e/organizations.ts` (the offer actions in the cross-organisation attack list);
  `scripts/e2e/messaging.ts` (no code on any delivery row; the cron hashes plain codes; a team-only number
  gets no code). The security review's exploits, each refused: `identityHardening` in
  `scripts/e2e/mobile-api.ts` (H1 own row + PATCH phone + unlink + email fallback, and its staff variant; M1 a
  rogue organisation's email on a matched row; M2 start bursts and the per-phone guess budget; L2 an offer's
  reach and matched-only offers; L3 Send code to a team contact; L6 merging profiles held by two accounts;
  unknown fields; L4 the hashing script with a wrong pepper; M3 the scrub) and the "player identity across
  organisations" section of `scripts/e2e/organizations.ts`.
  The scripts read one-time codes back from their hashes (they have the pepper), never from a message.

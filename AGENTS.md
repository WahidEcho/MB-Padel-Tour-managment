<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Move Beyond Tournament Management — agent notes

- Spec: `docs/move_beyond_tournament_management_spec.md`. README has the architecture summary.
- Supabase project id: `dwyztzywuscljqklhqij` (org `zigybnrxlgipryfgqvia`). Schema was applied
  via the Supabase MCP migration `init_tournament_schema`.
- All DB access is server-side through `src/lib/supabase.ts` (`db()`); the key is NOT public.
  Do not add `NEXT_PUBLIC_` Supabase env vars without first tightening RLS.
- Pure domain logic lives in `src/lib/` (scoring engine, round-robin, draws, standings,
  bracket) with vitest coverage — keep it framework-free. Server mutations live in
  `src/lib/ops.ts` and route/page `actions.ts` files.
- Offline referee scoring: Dexie queue in `src/lib/offline/db.ts`, sync endpoint
  `src/app/api/matches/[matchId]/events/route.ts` (ordered events, device lock, 409 conflicts).
- Verify with: `npm run lint`, `npx tsc --noEmit`, `npx vitest run`, `npm run build`, and the
  live-DB E2E: `npx tsx --env-file=.env.local scripts/smoke.ts` (creates + deletes its own data).
- No network route to the live project (cloud sessions): `npm run localdb` starts a local stand-in
  (PGlite + a PostgREST-compatible server on :54321, schema from `supabase/schema.sql` plus
  migrations ≥ 0014). Point `SUPABASE_URL=http://localhost:54321` at it and every E2E script runs.
  New migrations must also be applied to the live project (Supabase MCP `apply_migration`).
- Live database state (14 Oct 2026): migrations 0022–0030, the open-access gate (`supabase/gate/close_open_access.sql`)
  and the `gen_player_access_code()` search_path fix (0032) are applied on the live project; the repo matches it (0022 creates
  no policy, revokes anon/authenticated). Pending on live: `0031_league_visibility` (apply before deploying a build that reads
  `leagues.visibility`) and `0032_function_search_path` (already in effect there; recording it is harmless). The "not yet on the
  live project" notes below for 0018–0030 predate this. The owner applies live SQL (Claude never writes to the live database).
- Tennis team competitions (nations, ties of S2/S1/D rubbers, ITF ranking, placement draws for every
  place): `src/lib/tennis/`, admin pages `nations` and `ties`, gate `scripts/e2e/tennis-ties.ts`. Follows the 2026
  ITF regulations: singles named before play with the order-of-merit check, doubles "to be named" until after the
  singles (no reason needed after the lock); the doubles always played (demo opts out with
  `playDeadRubbersInPlacement: false`); Reg 38 ranking; Reg 36 lots (`format_config.ties.placementLots`); Reg 51
  short singles written per match as `scoring_config.matchRules` (applied last by `scoringConfigForMatch`, by id).
  The real Cairo events: `scripts/events/cairo-2026.ts` (SQL, drafts, public pages off).
- Tennis court TVs (`src/components/tennis/`, scenes decided by `src/lib/tennis/tvScene.ts`): a tie-format
  tournament's live screen runs line-up → walk-on → live score → rubber won → tie score per court on its own.
  Flags are local SVGs in `public/flags/` (from `flag-icons`, MIT). Gate on the stand-in only:
  `npm run e2e:tennis-tv` (plays the demo's first tie; screenshots + video to `OUT`).
- Tennis voice (pack `en-v3`: nation names, deciding point, match tie-break, change of ends, time). Until
  `public/voice/en-v3` is rendered (`npm run voice -- --provider kokoro` on a Mac; Hugging Face is blocked in
  cloud sessions) phones fall back to `en-v2` and `supportedCall` drops the calls it lacks. Gate:
  `npm run e2e:tennis-voice` (see the script header for its two passes; never commit the tone test pack).
- Finals replay (demo events only): `src/lib/tennis/replay.ts` turns a real score line into points the engine
  confirms; admin page `replay` plays a tie's rubbers through the events API (results in
  `format_config.ties.replays`). Demo `scripts/demo/finals-demo.ts` (2025 boys', 2024 girls' finals; loaded on the live project, slug
  `junior-team-finals-replay-demo`);
  gate `npm run e2e:tennis-replay` on the stand-in.
- Go-live: `docs/junior-finals-go-live.md`. Ties page has per-tie court + not-before time (entered in Cairo
  time, `zonedToIso`) and "Delay the order of play" (`delayOrderOfPlay`). Week rehearsal of both events with
  an offline referee, a late line-up change and rain: `npm run e2e:tennis-week` (stand-in, cleans up).
- **Move Score releases — owner's rule, no exceptions:** never publish a build to the App Store or
  TestFlight (no `eas submit`, no `testflight`/`production` submit profile, no App Store Connect upload, no
  store review) and never start one on someone else's behalf. iOS builds are for the owner's own phone only:
  `eas build --profile adhoc-local` (internal distribution, registered devices). Ask the owner before any
  store-facing step, even when a task or doc seems to call for it.
- Move Score mobile app: `move-score-app/` (Expo SDK 57). Its plan and decisions are
  `move-score-app/PRODUCT_PLAN.md` (single source of truth). The app imports pure code from
  `src/lib` through `move-score-app/src/core/index.ts`; anything it imports must stay free of
  Node, browser and Next.js APIs. App API: `src/app/api/mobile/v1/*`, contract in
  `src/lib/mobile/contract.ts`. App API check: `npx tsx --env-file=.env.localdb scripts/e2e/mobile-api.ts`.
- Move Score Google sign-in: Supabase OAuth + PKCE in the in-app browser sheet (`move-score-app/src/auth/signIn.ts`,
  `api/mobile/v1/auth/oauth/[provider]`, code exchange in `auth/session`); external setup in
  `move-score-app/docs/google-sign-in.md`. The stand-in emulates Supabase Auth (`scripts/localdb/auth.mjs`);
  gate `npm run e2e:mobile-signin`.
- Player codes (migration 0018, not yet on the live project): `players.access_code` / `phone` / `email` are private
  — `getTeams` lists player columns explicitly so they never reach public pages, screens or referee phones; keep
  it that way. Logic in `src/lib/players/` (claim, same-person rule, E.164, share links); admin tab
  `admin/tournaments/[id]/players`; app API `/me/player`, `/me/player/claim`, `/me/player/photo`; checked in
  `scripts/e2e/mobile-api.ts`. No age question at sign-in.
- Player identity (Phase 1, migration 0024, not yet on the live project): `docs/player-identity.md`. Linking in
  `src/lib/players/link.ts` (code / phone one-time code / email match / organiser offer; a code never links rows of
  another organisation). Player codes are looked up by `access_code_hash` (HMAC under `PLAYER_CODE_PEPPER`) and kept
  sealed for organisers (`codeVault.ts`); never select `access_code*` into public payloads and never write a code to
  `message_deliveries` (queue stores `code_ref`). WhatsApp codes need the `mb_login_code` authentication template
  (`WA_OTP_TEMPLATE`). E2E reads one-time codes from their hashes (the scripts have the pepper).
  Security review (migration `0026_identity_hardening`, apply with 0024): the email fallback mails only the account's
  own confirmed email and links only rows with both that phone and that email (never `phone_verified_at`); the app's
  own number goes to `players.self_reported_phone`, never `players.phone`; offers reach one organisation
  (`owner_scope_org`); no code to a team contact; deploy runs `hash-player-codes.ts` (checks the pepper against a
  sealed row) and `scrub-delivery-codes.ts`. Exploits are gated in `identityHardening` (mobile-api E2E).
- Database gate (closed on live, 14 Oct 2026): production's `SUPABASE_KEY` is the secret key (`/api/health/db` reports
  `"key":"secret"` via the `rls_canary` table) and `supabase/gate/close_open_access.sql` has run (rollback
  `reopen_open_access.sql`). `.env.local`'s anon key can no longer read the live project; use the stand-in or the secret key.
  Every migration from 0022 on creates no policy and grants nothing to anon/authenticated (`src/lib/migrations.test.ts`).
- Messaging (Admin → Announcements): email via Resend and WhatsApp Cloud API, one `message_deliveries` row per
  recipient per channel, chunked drain (`api/internal/messages/drain`, cron `supabase/ops/messaging_cron.sql`),
  webhooks `api/webhooks/resend|whatsapp`, `sendTransactional` in `src/lib/messaging/queue.ts`. Docs, env vars and
  WhatsApp templates to submit: `docs/messaging.md`. Never send for real from tests: `MESSAGING_DRY_RUN=1`;
  gate `npm run e2e:messaging` (stand-in, dry run).
- Email branding: one layout for every email (`src/lib/email/layout.ts`, Move Score header, Move Beyond
  signature). Supabase Auth templates are generated into `supabase/email-templates/` by
  `npx tsx scripts/email/build-auth-templates.ts` (test fails when stale); dashboard + SMTP steps in `docs/email.md`.
  Resend sends as `Move Score <no-reply@mbeg.org>`, reply-to `info@mbeg.org` (env overrides).
- Move Score email + player-code sign-in: routes `api/mobile/v1/auth/{email/*,player-code,complete}`, `GET /me`
  (registrationComplete), web pages `/movescore/auth/{confirm,reset}`, server logic `src/lib/auth/{accounts,links,limits}.ts`,
  shared rules `src/lib/auth/{password,sessionRules}.ts` (exported to the app via `@core`). Migration `0021_email_accounts`.
  The stand-in emulates sign-up, confirmation, password sign-in, recovery, OTP, anonymous users and its mailbox
  (`GET /auth/v1/_localdb/mail?to=`). Gates: `npm run e2e:mobile-signin` and the mobile-api E2E (player codes).
- Vercel skips a deploy when the pushed head commit only touches `move-score-app/` (vercel.json ignoreCommand diffs HEAD^..HEAD). When a push ends with an app-only commit (e.g. a version bump) after server changes, push a commit that touches the server too, or redeploy from the Vercel dashboard.
- Organisations (0023, `docs/organizations.md`): every posted id besides `tournament_id` goes through
  `ownershipRefusal`/`entityRefusal` or a scoped guard (source-scanned in `src/lib/adminGuards.test.ts`);
  person fields of a player another organisation has and this one only `matched` on its public form are
  masked (`src/lib/orgs/personFields.ts`). The shared `ADMIN_PASSWORD` is **not** a platform admin: after
  the deploy the owner reaches Discover/flags/merging only by signing in with their own Google or email
  account (owner SQL in `docs/organizations.md`). Production needs `STAFF_SESSION_SECRET` and
  `EVENT_CODE_PEPPER`; the web staff cookie is `__Host-mb_session` (plain `mb_session` on localhost only).
  `supabase/gate/reopen_open_access.sql` must never reopen the private tables (`src/lib/gateSql.test.ts`: every table from migration
  0022 on is classified, incl. `match_calls` and the Live Activity start tokens).
- Organisations part B (onboarding): apply `/organizations/apply` → platform admins decide in
  `admin/platform/organizations`; invites `src/lib/orgs/invites.ts` (HMAC-only tokens, email-bound,
  single use, 7 days, token in the link's `#fragment`; a sign-in never accepts or is blocked by one — it asks
  "Join … as …?" at `/invite`, Accept/Not now are `POST /invite/{accept,decline}`); members/profile pages
  `admin/org/{members,profile}` (personal accounts only: `PERSONAL_ACCOUNT_ONLY` in `src/lib/auth.ts`; renames
  wait for platform approval in `organizations.pending_name`, migration 0025); public org API
  `api/mobile/v1/orgs/[slug]` + app `org/[slug]`. A profile an organisation does not vouch for lends its rows no
  contact or photo (`hiddenPersonFields`). Staff-login brakes are atomic (`takeRateLimit`, compare-and-set, no RPC).
  Details, the 0.5B review fixes and deploy notes: `docs/organizations.md`. Gate: `npm run e2e:organizations` (stand-in).
- Public site: `https://tour.mbeg.org` (one constant, `src/lib/site.ts`, shared with the app through `@core`; server links read
  `PUBLIC_SITE_URL` first via `siteUrl()` in `src/lib/messaging/links.ts`). Never write the old `mb-tournament.vercel.app` host
  into links, emails or docs; it survives only as the legacy universal-link host in `move-score-app/app.config.ts`.
- Match day (plan Phase 0; migration 0022, not yet on the live project — apply it before deploying, the new-tournament insert
  writes `match_day_rules`): sports registry `src/lib/sports/registry.ts` (`sportOf()`; ratchet test caps `sport === "…"`
  branches), rules `src/lib/matchday/rules.ts` (`{}` = off until the admin **Match day** tab saves; new tournaments get the
  defaults), `isMatchDay` in `src/lib/matchday/eventDay.ts`, Admin → Discover (`admin/platform/discover`, admin only) for the
  hero order (`platform_settings.discover_order`, featured events) and app flags. `migrations.test.ts` fails any table from
  0022 on without RLS. Prefs PATCH merges with what is stored.
- Organisations (migration 0023, not yet on the live project; docs `docs/organizations.md`): every staff request
  resolves a principal in `src/lib/auth/staff.ts` (member `mbs1.` cookie, event code, or the Move Beyond-only shared
  passwords) re-checked in the DB each time; guards in `src/lib/guard.ts` resolve the organisation from the row
  (`src/lib/orgs/scope.ts`), never a posted id. New admin actions/pages/staff routes must use them —
  `src/lib/adminGuards.test.ts` fails otherwise. `STAFF_SESSION_SECRET` is required in production. Attack gate:
  `npm run e2e:organizations` (stand-in; reads action ids from the build's `.next` manifest).
- Live courts hero (plan Phase 4): scenes per court in `src/lib/tv/showcase.ts` (shared via `@core`; ties and one-match
  fixtures, `called` from `match_calls`, TV timings from `tennis/tvScene.ts`), server `src/lib/mobile/courts.ts` behind
  `GET /api/mobile/v1/courts/live` (CDN 2 s; featured + live tournaments in the Discover order, only where the Match day
  showcase is on and `supports.showcase`; flag `live_courts`), app `move-score-app/src/ui/LiveCourtsHero.tsx` on Discover.
  Explicit columns only — `courts.test.ts` fails on a private column or field. The bundle also carries `rules` (per stage,
  `rulesForMatch`) and `sides` (red/blue); `MMatch.bracketId` tells a Plate match.
- iPhone Live Activities + widgets (Phase 6): card phases soon|called|live|final and payloads in
  `src/lib/notify/liveActivity.ts` (pure, `@core`), transport + `pushToStart` in `src/lib/notify/apns.ts`,
  `notifyLiveActivityPhase` in `hooks.ts`, start tokens `api/mobile/v1/me/live-activity/start-token`, widget rows
  `api/mobile/v1/me/widget`. App: `move-score-app/src/live/*`, expo-widgets patched (`move-score-app/patches/`),
  switches `MS_LIVE_ACTIVITIES` / `MS_WIDGETS` / `MS_APP_GROUP` in `app.config.ts`. Profiles, install, checklist:
  `move-score-app/docs/device-install.md`; spike `scripts/live-activity/start-spike.ts`.
- Final-result entry (plan Phase 2): event `RESULT_ENTERED` (payload `{sets}` or chess `{chess, advance?}`, `src/lib/scoring/resultEntry.ts`,
  shared via `@core`). The one write path for score events is `src/lib/scoring/append.ts` (events route + admin action
  `enterMatchResult` on the matches page): the server rebuilds the state with `stateFromFinalScore`/`chessStateFromResults` and
  refuses a bad score or a differing client state (400 `code: "final_score"`, typed `problems`). Allowed only when the match's
  mode (override → session → match-day rules) is `final_score`/`either`. A result over a partly scored or finished match is an
  audited correction by the organiser's staff only (admin/manager; a referee code gets 409 `organiser_only`, decided before the lease is
  touched — `correctionCut`; in chess, ending a level pairing with a winner is the organiser's too, `chessDecisionCut`); a session's
  knockout retracts its later round like a tournament's, and a Mexicano result is frozen once the next round is drawn (409
  `next_round_drawn`) (`RESULT_CORRECTED`; earlier events `sync_status = 'superseded'`; undo paths retract the bracket / ledger /
  tie first); `matches.result_source` is `point_by_point|final_score|correction` (0022 check). A result ends the undo chain
  (`getReopenState`, bootstrap history). Chess: every format today is a knockout, so a level pairing stays live
  (`needsArbiter`) until the organiser picks who advances (`decideWinner`); a draw outside a knockout is refused
  (`draw_unsupported`) because standings have no draws. Web UI `src/components/scoring/FinalScoreEntry.tsx`; offline queue
  helpers `src/lib/offline/finalResult.ts`. Gate `npm run e2e:final-score` (stand-in).
  An UNDO after an entered result is refused (409 `conflict: "result_entered"`); a correction of a finished match sends no
  second "match finished" (`finalizeMatch({ notifyFinished: false })`).
- Match-day engine (plan Phase 3): `src/lib/matchday/server.ts` over the pure `call.ts`/`nearEnd.ts`/`courtQueue.ts`.
  "Match soon" runs from `append.ts` after each batch and goes once per match (`matches.match_soon_at`, claimed with a
  filtered update) to the next match on the court's linked players, never for a TBD side or players live on another court.
  Calls live in `match_calls` (status `called|started|walkover|cancelled`; match status `ready` while called); routes
  `api/matches/[matchId]/call` (staff, `score_match`, org-scoped; call/extend/cancel at most 12 per match per 10 min, atomic
  `takeRateLimit`; "called to court" reaches the players at most once per match per 10 min) and `api/mobile/v1/me/matches/[matchId]/here` (only the
  account's own match via `player_claims`); a court QR check-in by a player marks them present; opening the match on a
  referee console auto-calls it (rules toggle, match days). Alerts `match_soon`/`called_to_court`/`call_reminder`
  (category `court`); `payload.self` = the players' own wording, chosen per phone in the drain; `recipientsFor` adds
  accounts linked to `player` targets. The reminder is a future `notification_events` row sent by the scheduled drain.
  `PUSH_DRY_RUN=1` sends nothing (tickets `dry-run[:self]`). Gate `npm run e2e:match-day` (stand-in; server started with
  `PUSH_DRY_RUN=1`).
- Leagues (Phase 7, migration `0027_leagues`, not yet on the live project): pure `src/lib/leagues/{points,boards,join,settings,fixtures,results}.ts`
  (shared with the app through `@core`), server `src/lib/leagues/{server,ops,inviteCode}.ts`, admin `admin/leagues`, app API
  `leagues/[slug]`, `leagues/[slug]/join`, `leagues/top`, `me/leagues`; app screens `league/[slug]`, `leagues`. Points are recomputed from
  results by the hooks in `src/lib/results/hooks.ts` (finalise, undo, correction, reset), unique per match + player. "Which profile is
  this user" is `profileForUser` only (reads `player_profiles.auth_user_id`, nothing else). Joining makes the player the organisation's as
  `matched` (vouches for nothing; `league` is non-vouching too, `sourceVouches`). Boards, league pages and admin league pages name players
  through `orgDisplayNames`; the platform "Top of all" board scores results on the default scale (`onPlatformScale`). League sessions
  (nights, season fixtures) of approved organisations are the only friendly sessions the app shows. Gate: `npm run e2e:leagues` (stand-in).
  Visibility (migration `0031_league_visibility`, pure `src/lib/leagues/visibility.ts`): `everyone` (default) | `org_players` (the org's
  players with a vouching source, the league's members, the org's active staff) | `invite_only` (members, accounts that entered the
  current invite code — `POST leagues/code`, table `league_code_holders`, rate limit shared with joining — and staff). Platform admins
  are not staff here. Only `everyone` leagues reach shared/CDN routes (`leagues/[slug]`, `orgs/[slug]`, `leagues/top`, `t/[slug]/*`,
  courts hero via `isPublicLeagueSession`); restricted ones are served on per-user `private, no-store` routes (`me/leagues/[slug]`,
  `me/leagues` `visible`, `me/t/[slug]/{bundle,live,standings}` gated by `tournamentVisibleTo`, which also lets a player into a night
  they play in), and anyone else gets the missing-league 404. Their points never count on the public top boards. The app reads the
  public URL first and falls back to the `me/` path on a 404 when signed in (`publicOrMine` in `move-score-app/src/api/queries.ts`).
- Americano / Mexicano nights (Phase 8, no migration): pure `src/lib/friendly/nightTable.ts` (`buildNightTable` view model every surface
  draws, `reestimateNight`; `NIGHT_TABLE_LAYOUT` is the one switch for the owner's pending reference layout), server
  `src/lib/friendly/nights.ts` (`publishNightTable` = "Confirm players and publish table", `reestimateSessionTable` from the
  `results/hooks.ts` finish/undo hooks and match start, `linkNightPlayers` = `linkProfileRowsIn` in `src/lib/players/link.ts`: the one linking
  rule, never `league_members.auth_user_id` alone). Order
  of play per court = `match_order`; estimates in `matches.scheduled_time`; published flag `format_config.nightTable`. Alerts only to the
  players' own accounts, only for public league nights. The Americano points format is unchanged (still 3 / 0 + fire on the night's
  own table; league points from the league rules). Gate: `npm run e2e:nights` (stand-in, `PUSH_DRY_RUN=1`).
- Registration and payment (Phase 9): `src/lib/registration/` (`rules.ts` pure + tests, `server.ts`, `moveTick.ts`,
  `signature.ts`), migration `0028_registration.sql` (not yet on the live project), admin tab `admin/tournaments/[id]/registrations`
  (refunds: `refund_registrations`, admins with their own account), web `/register/<slug>` and `/register/status`, app
  `register/[slug]` + `registrations`. Online payment only for Move Beyond, **directly through XPay** (decision 14 Oct 2026,
  `docs/xpay-direct.md`): client `src/lib/payments/xpay.ts`, webhook `api/webhooks/xpay` (`xpayWebhook.ts`), switch
  `src/lib/payments/provider.ts` (`PAYMENT_PROVIDER=xpay|move_tick`; default XPay once `XPAY_SECRET_KEY` is set), migration
  `0033_payment_provider.sql` (not yet on the live project; apply before deploying). Env `XPAY_SECRET_KEY` (sk_test_/sk_live_ =
  the mode), `XPAY_WEBHOOK_SECRET` (Move Score's own endpoint), optional `XPAY_PAYMENT_METHOD_TYPES`. Checkout metadata
  `{ app: "move-score", registration_id, payment_id }`; other apps' sessions (Move Tick's tickets, same XPay account) answer 200
  and are ignored. Card minimum EGP 50 (`CARD_MINIMUM`). The Move Tick partner API path (`api/webhooks/move-tick`,
  `docs/move-tick-partner-api.md`, Move Tick branch `move-score-partner-api`) still works with `PAYMENT_PROVIDER=move_tick`.
  Gate: `npm run e2e:registration`, **once per provider** (server and script both with `PAYMENT_PROVIDER=xpay`, then
  `move_tick`; the script runs a fake XPay on `XPAY_API_BASE`'s port / a fake Move Tick on `MOVE_TICK_API_URL`'s;
  `.env.localdb` needs `XPAY_SECRET_KEY=sk_test_…`, `XPAY_WEBHOOK_SECRET`, `XPAY_API_BASE` and the four `MOVE_TICK_*`).
  Demo fakes: `scripts/demo/fake-xpay.ts`, `scripts/demo/fake-move-tick.ts`.
  The messaging cron also archives finished events' player links (`player_claims.archived_at`).
  Hardening (security review): migration `0029_registration_hardening.sql` (not yet on the live project; apply after 0028):
  web guests confirm by an emailed link (`unconfirmed`, `/register/confirm`), app registration needs a confirmed email, messages
  only to `registrations.notify_email` (verified), one open checkout per registration, refunds by payment id, status page Pay
  button (`/api/register/pay`). Move Tick partner branch: one open session per reference (`409 PAYMENT_SESSION_OPEN`).
- Admin refusals: an expected, user-facing refusal in a server action throws `Refusal` (`src/lib/refusal.ts`) and the action
  returns `formResult(...)` to a `StateForm` (inline message next to the button); guards and genuine failures still throw.
  Registrations, leagues, night publish and Discover flags use it; E2E calls such actions as `[null, form]` and treats
  `"ok":false` as refused.
  Owner's final decisions (DECISIONS.md § 8; migration `0030_registration_first_paid.sql`, not yet on the live project; apply
  after 0029): default `approval_mode = on_payment` ("first paid, first in"; `automatic` is gone, `organiser` stays): registering
  holds no place and opens no checkout; Pay takes a 15-min checkout hold (`CHECKOUT_HOLD_MS` = Move Tick's
  `PARTNER_SESSION_TTL_MINUTES`) only while a place is free (else 409 `full` before any checkout); the full `amount_online`
  paid → `confirmed`, no organiser step; a payment into a full event → `needs_review`, admins + player emailed, refund in full
  any time. Capacity = players of confirmed entries + unexpired holds (`hold_kind` checkout|approval; organiser mode keeps its
  24 h approval hold), trigger `registration_capacity_guard` (0030). Entry type `individual|team|both` (both: the player picks;
  a solo fills one of a team's places; solos paired by `pairRegistrations`). Refunds always 100 % (no card-fee setting).
  Local walkthrough: `npx tsx --env-file=.env.localdb scripts/demo/registration-demo.ts` + `scripts/demo/fake-move-tick.ts`.
- Old-app compatibility: Move Score 1.0.1 (built from `0159033`) is in people's hands. `npm run e2e:old-app` (stand-in)
  replays its calls as it builds them (headers, bodies, referee queue batches) and checks every response against
  0159033's contract types. Keep it green before every deploy; never remove a response field or tighten a body 1.0.1 sends.
- Court referee codes (migration `0034_court_codes`, not yet on the live project; apply before deploying): a referee code limited to one
  physical court (`organization_codes.court_name` + `event_group_id` or `tournament_id`; sealed `code_sealed` so the QR sheet reprints).
  Pure rules `src/lib/orgs/courtScope.ts` (today's list, "Show earlier days", carry-over lapse, `/r#<code>` link), server
  `src/lib/orgs/courtCodes.ts`, reach in `principalReaches` (court codes reach their court's matches + their tournaments' lists only).
  Admin Event codes → Court codes (`admin/org/codes/courts`), QR sheet `/qr/courts?event=`. The QR (`https://tour.mbeg.org/r#<code>`,
  code in the #fragment) is a universal link (`/r` in AASA, Android `path: "/r"`); `/r` on the web never signs a browser in. Switching
  courts is never blocked: `issueCarry` (staff.ts) returns a carry-over token (`m` match list in the code token; app header
  `X-Staff-Carry`, web cookie `mb_carry`) for the old court's unsent/unfinished matches only. Gate: `npm run e2e:court-codes` (stand-in).
- Referee PINs, master referees, calls for assistance (migration `0035_referees.sql`, not yet on the live project; apply before
  deploying: audit rows write `actor_name`): `docs/referees.md`. Roster `referees` (PIN = HMAC under `EVENT_CODE_PEPPER`,
  `src/lib/referees/pin.ts`), sign-ins `referee_sessions`, `assistance_calls`. A court code or a master code (`organization_codes.role
  = 'master_referee'`, `referee_id`) signs in only with a PIN (`checkRefereePin`: per-code lock + per-address brake, failed attempts
  only); tokens carry `p`/`s`, re-checked every request (`refereeForToken`). 1.0.1 types `<code> <PIN>` in its one field
  (`splitCodeAndPin`). Master referees: `scopeTournamentIds` + `MASTER_REFEREE_PERMISSIONS` (src/lib/auth.ts); web `/referee/master`,
  `/referee/tournaments/[id]/desk`; app `referee/master`, `referee/pin`, `AssistanceCard`. Admin `admin/org/referees` (+ `/live`,
  `/calls`). Calls route `api/mobile/v1/referee/assistance` (staff only, never public). Gate `npm run e2e:referees` (stand-in,
  `PUSH_DRY_RUN=1`).
- Line-ups on match day (no migration): pure checks `src/lib/tennis/lineupRules.ts` (problems refuse; warnings — order of merit
  Reg 43, retired player Reg 50 — need accepting; a change after the lock needs a reason), regulation summaries in our own words
  `src/lib/tennis/regulations.ts` (page `/regulations/itf-junior-team/[reg]`, button to the ITF site), Excel sheet pure
  `lineupSheet.ts` + server `lineupSheetServer.ts`, server `lineupServer.ts` (who: organiser, master referee, the tie's court
  referee — `lineupActor`; accepted exceptions → audit `LINEUP_EXCEPTION_ACCEPTED`, push to masters on duty, banners from
  `GET /api/mobile/v1/referee/notices`). Routes `referee/matches/[matchId]/lineup`, `referee/tournaments/[id]/lineups/{template,preview,apply}`.
  Web picker `src/components/lineups/LineupPicker.tsx`, sheet `LineupSheet.tsx` (admin Ties page, master desk); app
  `move-score-app/src/referee/LineupPicker.tsx`. Referee screens follow the device/app theme (`.theme-auto`; "☀ Sunlight" =
  `.theme-sunlight` / app `SUNLIGHT`). Gate `npm run e2e:lineups` (stand-in, server with `PUSH_DRY_RUN=1`).
- Live stream (YouTube Live per court, no migration): settings in `tournaments.branding_config.liveVideo` (per court id: video id,
  on/off, delay; overlay title), admin tab `admin/tournaments/[id]/live-stream` (`saveLiveVideo` / `saveOverlayTitle`, CAS via
  `updateBranding`). Pure `src/lib/stream/{youtube,liveVideo,overlay}.ts`; `toPublicTournament` drops `liveVideo`. Public payloads
  (bundle courts, live, match detail, courts hero) carry `liveVideo` only for a streamed court and only on its match in play
  (additive). OBS overlay `/t/[slug]/overlay/[court id|name]` (transparent 1920×1080, `?bug=0&footer=0&scale=&idle=0`), polling
  the TV live feed. Web player `src/components/stream/YouTubeLivePlayer.tsx`; app `move-score-app/src/ui/LiveVideo.tsx`
  (needs `react-native-webview` 13.16.1, required lazily so older binaries fall back to "Open on YouTube"). Operator guide
  `docs/live-stream.md`. Gate `npm run e2e:live-stream` (stand-in).
- Referee sign-in audit fixes (20 Oct 2026, `docs/referees.md`): after a court code the referee picks their name, the PIN is
  checked against that referee only; brakes per referee / organisation (alert `REFEREE_PIN_BRAKE` + `staff_alert` email) / address,
  known devices (`referee_sessions.device_hash`, migration `0041_referee_pin_brakes.sql`, not yet on the live project: apply it
  before deploying), never per court code; 1.0.1's nameless "<code> <PIN>" runs on an org budget. Masters: `master_desk` only.
  Scoring: v2 events must chain from the stored snapshot (409 `stale_state`), court codes cannot write to a match finished over
  30 min ago (409 `finished_locked`).
- National team coaches (migration `0037_coach_access.sql`, not yet on the live project; docs `docs/coaches.md`): one code per
  team (`coach_codes`, hashed + sealed like court codes), shared by every coach of the team; sign-ins in `coach_sessions`
  (phones for alerts). Coach tokens `mbc1.` (`src/lib/coaches/token.ts`) are never staff tokens. Server `src/lib/coaches/server.ts`
  (explicit columns only, another team's rows = 404), pure rules `rules.ts` (via `@core`), alerts `alerts.ts` (target
  `coach_team`). Admin `admin/org/coaches` (admins only, `manage_coaches`), cards `/qr/coaches`, web `/coach/*`, QR `/c`,
  app `move-score-app/src/app/coach/*` + `c.tsx`. Gate: `npm run e2e:coaches` (stand-in, `PUSH_DRY_RUN=1`).
  Coach line-up entry (no migration): **off until officially confirmed** — admin switch per event on Admin → Team coaches
  (`format_config.ties.coachLineups`, never in any default); while off the coach POST is 409 `feature_off` and nothing shows.
  On: pure `src/lib/coaches/lineupEntry.ts`, server `src/lib/coaches/lineups.ts`; a submission is an audit row
  `COACH_LINEUP_SUBMITTED` (never written to the rubbers, so the opponent never sees it); officials' pickers get the additive
  `coach` field (prefilled, "Submitted by the coach at HH:MM"; confirming locks it).
- Player pages (no migration): pure `src/lib/players/publicInfo.ts` (via `@core`: `playerRecord` singles/doubles W–L). ITF junior
  ranking typed per player on admin Nations, stored in `format_config.itfJuniorRanks` (CAS on `updated_at`), sent as `MPlayer.itfRank`.
  Ages: juniors are minors, so only with App tab "Show players' ages" (`app_skin.showAges`, default off) and only as `MPlayer.age`
  computed from the linked profile's `birth_year` (`publicAges` in `src/lib/mobile/server.ts`; never the year, never for a profile
  the organisation does not vouch for). Player follows get match soon / live / result (`composeMatchSoon` targets the players).
- Venue map (migration `0039_venue_map.sql`, not yet on the live project; `docs/venue-map.md`): pure `src/lib/venue/` (routing,
  geo, directions, navigation, DXF, scene/camera maths, bridge via `@core`), WebGL renderer + UI `src/components/venue/`, page
  `/t/<slug>/map`, API `api/mobile/v1/t/[slug]/venue{,/live,/route}`, editor + Survey mode `admin/tournaments/[id]/venue`, app
  screen `move-score-app/src/app/venue/[slug].tsx` (WebView + expo-location). The public venue is an explicit projection (no
  underlay, no survey fixes). Gate `npm run e2e:venue-map` (stand-in). The sample layout's anchor is a placeholder.
- Fan stats (no migration): pure `src/lib/scoring/stats.ts` (via `@core`; replays the non-superseded, non-undone score events: the stored
  state before each point gives the server and break points, never in a tie-break; only POINT_AWARDED counts as a point played),
  server `src/lib/mobile/stats.ts` (explicit columns, a few JSON fields of each previous state, never `created_by`), routes
  `api/mobile/v1/matches/[matchId]/stats` and `ties/[tieId]/stats` (public tournaments only, CDN 3 s live / 60 s done; aces only
  when `tvAces` and `ace` are on). A final-score result has none ("Recorded point by point only"). App `ui/StatsCard.tsx` on the
  match and tie screens, web `components/MatchStatsCard.tsx` on the public match page. Gate `npm run e2e:stats` (stand-in).
- Order of play + notices (no migration): pure `src/lib/schedule/orderOfPlay.ts` (days in the event's zone, by court / by time,
  "followed by" ordering) and `src/lib/notices/playStatus.ts` (both via `@core`). App: Schedule tab (key `ties`) and the Matches tab
  use `move-score-app/src/ui/Schedule.tsx`; banner `ui/NoticeBanner.tsx`. Play status (normal|delayed|suspended|resumed) is set on
  Admin → In the app (`savePlayStatus`, `branding_config.playStatus` via `updateBranding`, optional push via `notifyPlayStatus`), sent
  additively as `MLive.playStatus`; public web banner `src/components/PlayNotice.tsx`, web ties page day picker `DayTabs`.
  Gate `npm run e2e:play-status` (stand-in).
- Event info for fans (no migration): stored in the owner tournament's `branding_config.eventInfo` (an event group's first
  tournament holds the group's info, `eventInfoOwnerOf` in `src/lib/eventInfo/server.ts`; CAS via `updateBranding` plus the editor's
  `updatedAt`). Pure `src/lib/eventInfo/{clean,hours,links,public}.ts` (sanitiser: plain text, https only, map hosts for map links,
  E.164; the open-now chip on the venue's clock; via `@core`). `toPublicTournament` and cloning drop `eventInfo`. Admin tab
  `admin/tournaments/[id]/event-info` (placeholders only, never invented facts), API `GET /api/mobile/v1/t/[slug]/info` (published
  only, explicit keys, CDN 60 s), web `/t/[slug]/info` (nav "Info"), app `t/[slug]/info` (+ `ui/EventInfoLink` in the hub header;
  `openVenueMap(slug, court, focus)` takes `poi:<id>`). Gate `npm run e2e:event-info` (stand-in).
- App languages (en/es/fr, no migration; website and emails stay English): `move-score-app/src/i18n/` — `en/<ns>.ts` is the
  source of truth, `es/`/`fr/` typed `Shape<typeof en>` (a missing key fails tsc; `i18n.test.ts` checks empties, placeholders,
  plurals). In components `const tr = useT()` (`t` is the theme palette), plain modules `tr`/`fmt()` from `i18n/t`. Language =
  Account → Language (Automatic follows the phone), sent as `push_devices.locale` on registration. Alerts: compose functions write
  English in `title`/`body` plus `payload.tr.{es,fr}` (`src/lib/notify/i18n.ts`), the drain picks per phone (`wordsFor`); people's
  announcements go out as written; lock-screen cards pushed by the server carry `labels` for es/fr (`lockWords.ts`, kept equal to
  the app's `lock` namespace by test). Never write new user-visible English in the app without adding es/fr.
- Account name and photo (no migration): `PATCH /api/mobile/v1/me/account` `{ displayName }` (`src/lib/auth/displayName.ts`), `POST|DELETE
  /api/mobile/v1/me/account/photo` (media bucket `accounts/<userId>/`), written to the auth user's metadata with the user's own token
  (`src/lib/auth/accountProfile.ts`); user choices live under `custom_name`/`name_custom` and `custom_avatar_url`/`avatar_custom` (only
  trusted inside our own `media/accounts/` folder) so a later Apple/Google sign-in never overwrites them. Apple sends the name only on the
  first authorization. App sheet `move-score-app/src/auth/EditProfileSheet.tsx` (Account → Edit name and photo). Gate `npm run e2e:mobile-signin`.

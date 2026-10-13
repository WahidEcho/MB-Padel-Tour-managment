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
- Tennis team competitions (nations, ties of S2/S1/D rubbers, ITF ranking, placement draws for every
  place): `src/lib/tennis/`, admin pages `nations` and `ties`, gate `scripts/e2e/tennis-ties.ts`.
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
- Open go-live item (agreed for after the 25 Sept rehearsal): live RLS still grants `anon` full access
  (`server_full_access`); switch `SUPABASE_KEY` to the secret key in Vercel before dropping those policies.
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
- Database gate (still open): production's `SUPABASE_KEY` is already the secret key (13 Oct 2026; `/api/health/db`
  reports `"key":"secret"` via the `rls_canary` table). Next: run `supabase/gate/close_open_access.sql` (rollback
  `reopen_open_access.sql`). It must be on the live project before migration 0023 (organisations) is applied there.
  After it, `.env.local`'s anon key can no longer read the live project; use the stand-in or the secret key.
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
  `supabase/gate/reopen_open_access.sql` must never reopen the private tables (`src/lib/gateSql.test.ts`).
- Organisations part B (onboarding): apply `/organizations/apply` → platform admins decide in
  `admin/platform/organizations`; invites `src/lib/orgs/invites.ts` (HMAC-only tokens, email-bound,
  single use, 7 days; accepted inside the staff sign-in); members/profile pages `admin/org/{members,profile}`;
  public org API `api/mobile/v1/orgs/[slug]` + app `org/[slug]`. Details and deploy notes: `docs/organizations.md`.
  Gate: `npm run e2e:organizations` (stand-in).
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
  audited correction (`RESULT_CORRECTED`; earlier events `sync_status = 'superseded'`; undo paths retract the bracket / ledger /
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
  `api/matches/[matchId]/call` (staff, `score_match`, org-scoped) and `api/mobile/v1/me/matches/[matchId]/here` (only the
  account's own match via `player_claims`); a court QR check-in by a player marks them present; opening the match on a
  referee console auto-calls it (rules toggle, match days). Alerts `match_soon`/`called_to_court`/`call_reminder`
  (category `court`); `payload.self` = the players' own wording, chosen per phone in the drain; `recipientsFor` adds
  accounts linked to `player` targets. The reminder is a future `notification_events` row sent by the scheduled drain.
  `PUSH_DRY_RUN=1` sends nothing (tickets `dry-run[:self]`). Gate `npm run e2e:match-day` (stand-in; server started with
  `PUSH_DRY_RUN=1`).
- Leagues (Phase 7, migration `0025_leagues`, not yet on the live project): pure `src/lib/leagues/{points,boards,join,settings,fixtures,results}.ts`
  (shared with the app through `@core`), server `src/lib/leagues/{server,ops,inviteCode}.ts`, admin `admin/leagues`, app API
  `leagues/[slug]`, `leagues/[slug]/join`, `leagues/top`, `me/leagues`; app screens `league/[slug]`, `leagues`. Points are recomputed from
  results by the hooks in `src/lib/results/hooks.ts` (finalise, undo, correction, reset), unique per match + player. "Which profile is
  this user" is `profileForUser` only (switches to `auth_user_id` with Phase 1). League sessions (nights, season fixtures) are the only
  friendly sessions the app shows. Gate: `npm run e2e:leagues` (stand-in).

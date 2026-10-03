# Move Score — master plan (reviewed 1 October 2026)

## Context

`PRODUCT_PLAN.md` (the Move Score mobile master plan; also `move-score-app/PRODUCT_PLAN.md` on the
`move-score-mobile` branch) was written without reading the code closely, and the Figma file
(`Move Score Mobile`: 02 Audience, 03 Player, 04 Referee) was drawn from that plan. The owner asked for a
review of both, every gap closed by questions, design inspiration research, a more eye-catching design with
unique animations, the supplied MOVESCORE logo as the final logo, and an app people show off because they
used it at the event.

First event: **Davis Cup Junior Finals (boys) + Billie Jean King Cup Junior Finals (girls)**: two separate
tournaments, 16 nations each, Smash Sporting Club Cairo, **2–8 November 2026**. Today is 1 October.
Team: the owner and Claude. Nothing is built yet; the mobile branch holds two docs.

This file records what is wrong in the plan, what was decided, the design direction, the architecture, and
a dated build sequence. The first deliverable after approval is an interactive prototype (§9).

---

## 1. Verdict on the Figma file

Use it as a content checklist only, not as the visual basis.

- Wrong brand: warm off-white, red, Manrope. The brand is near-black, electric blue, neon yellow.
- Misses the plan's own requirements: no tie → rubbers view, no doubles, no sponsor placement, no flags
  (text chips with wrong codes "UNI", "JAP", "ROM"), no tournament hub, bracket, standings or Following feed.
- Text clips on six frames.
- Referee screen: two 72pt buttons, bottom half empty, none of what the web console does today.
  "DEVICE LOCKED" describes the old permanent lock, which was replaced by a lease in September.
- Worth keeping: Discover's hierarchy, the match-card fields, the follow callout copy.

## 2. Corrections to PRODUCT_PLAN.md

| Plan says | Reality (code on `origin/main`, live database) | Consequence |
|---|---|---|
| §21 security gate | Still open: 31 of 31 tables allow anonymous read/write; the `media` storage bucket allows anonymous upload, overwrite, delete; server runs on the anon key. Supabase's security advisor reports nothing, so it cannot be the proof | First backend task; verified by direct anon requests |
| §53 "staging + production exist" | No staging; E2E scripts run against the live database. `supabase/schema.sql` is not a usable baseline (no RLS, policies, storage, most indexes) | Staging built from a real dump of production |
| §12.4 "server validates" | `events/route.ts` stores the client's `new_state` and `winner_team_id` unchecked, and can get permanently stuck in three ways (mid-batch insert failure; undo-reopen refusal after the row is inserted; a failed finalise that is never retried) | Server hardening in week 2 |
| §20.3 access code reused by native | Login is a Server Action that sets a cookie: no JSON login, no bearer token, no rate limit on code attempts, plain string compare | Token endpoint + rate limit |
| §12.8 handover = admin releases | 15 s lease with request / accept / decline between phones | Native speaks the lease protocol |
| §5.2 one `featured_tournament_id` | The event is two tournaments | Featured becomes an event group |
| §5.3 city, venue, dates on cards | `tournaments` has none of these and no time zone (Cairo is hardcoded); the admin Matches page reads times as UTC (2-hour error) | New columns; fix before alerts carry times |
| §3.6 web is the fallback | Public pages show no ties, nations or flags | Web tie and nation views |
| §28 scale | Every public page is a full server render every 4–8 s (~9 queries). Server runs in the US, database in Ireland: 1.0–1.5 s per response | Cached feeds; move server region to Dublin |
| §23 Expo | Expo Go does not work for current SDKs | Development builds from day one (SDK 57) |
| §25 palette, fonts | Contradict the brand | Replaced by §4 |
| §10.3 juniors hold accounts | Egypt's data law needs a guardian's written consent under 15; event decided "no player photos" | Superseded 3 Oct: player codes on, no age question (see Accounts below). Public photos still follow the event's "Show player photos" switch; codes for juniors go to a parent or guardian |
| §17 Ads Manager in V1 | Sponsors have no link field or tracking | App shows existing sponsors read-only; Ads Manager after the event |
| §31 Expo push for everything | Expo's service cannot update a lock-screen Live Activity; that needs direct Apple push | Separate sender for #3 |
| §40 five-day sprint | Not credible | Replaced by §6 |
| Not mentioned | Friendly sessions, chess, voice umpire, changeovers, code violations, red/blue teams, demo events | Scoped in §3 |
| `DECISIONS.md` §5, the spec | List native app, player claiming and push as "not being built" | Update both when work starts |

Local `main` is 14 commits behind `origin/main` (all the tennis work). Pull first, then merge main into the mobile branch.

## 3. Decisions locked in this session

| Topic | Decision |
|---|---|
| Native V1 scope | Spectator + referee scoring. Player codes (claim) on. Admin, TV operator, sponsor management stay on the web; chess scoring and voice umpire stay web-only |
| Referee rollout | Native primary, web console as fallback. Go/no-go after a venue rehearsal in the last week of October |
| Accounts | Optional Apple / Google sign-in, no age question (the "I am 16 or older" switch was removed 3 Oct). Guests star, follow and get alerts on that phone. Staff keep access codes |
| Player codes | Every player has `players.access_code` (8 chars, 23456789ABCDEFGHJKMNPQRSTUVWXYZ). Admin tab "Player codes" copies, shares on WhatsApp / email, resets (unlinks) and exports CSV. In the app: Account → Player code (signed-in only) → "You're <name>"; My player profile has photo, phone and matches. One account per player; one claim links the same person's rows in other tournaments only on a shared profile, or the same name plus the same phone or email |
| Stores | Apple: existing individual account. Google: new personal account |
| Event rights | Official provider, nothing written. Ask for a short letter now; event names as plain text, no federation logos until it arrives |
| Themes | Light and dark everywhere |
| Event skin | Full reskin inside a tournament's pages |
| Fonts | Wordmark is an image; matching free fonts chosen in the prototype |
| Show-off order | 1 event pass (pack-opening, venue QR unlock, day stamps, Wallet) · 2 share cards · 3 lock-screen live score · 4 big-moment takeovers · then supporter mode, nation pins, momentum chart, staff badge, recap |
| Hosting | Build on the free tiers. Decide on upgrading from measured numbers on **26 October**, 7 days before the event (risk R1) |
| Website | Tie and nation views before the event; rebrand after 8 November |
| First output | Interactive prototype |

## 4. Design direction — "Stage Light"

The brand artwork is an arena floor lit by blue and yellow beams. The app is that stage: a near-black floor,
light that moves, and one neon yellow object, the ball.

**Colour** (sampled from the supplied artwork; tuned in the prototype)

| Token | Dark | Light | Rule |
|---|---|---|---|
| Floor | `#00000B` → `#01041A` | `#F6F7F9` | |
| Ink | `#E8ECF4` | `#05060A` | Off-white on dark avoids glare |
| Ball yellow | `#FCFC00` | same, fills only | ≈17:1 on the floor, ≈1.1:1 on white: never text on a light surface, never text on blue |
| Primary button | yellow fill, black label | black fill, yellow label | Same pair inverted; yellow never touches white |
| Beam blue | `#1E6BFF` glow, `#4D9BFF` links | `#0057FF` | Light, links, info |
| Live | `#FF2D55` dot + "LIVE" | `#E5133A` | Never colour alone |
| Win / loss | yellow marker + bold / dimmed | bold / dimmed | No red-versus-green |

Yellow means "the ball": serve dot, winner marker, active tab, primary action. Nothing else.

**Type.** One family at two widths (the Sofascore / Apple Sports approach): a wide heavy cut for headlines
beside the wordmark, a condensed tabular cut for scores. Candidates compared live in the prototype:
Archivo (Expanded Black + SemiCondensed), Unbounded, Michroma. Body in Geist, as on the website.

**Logo.** Cut the wordmark from the supplied image (it sits on near-black at 306,356–1298,425, so a clean
luminance key works). It is ~990 px wide: enough for the header, not for store art. It always sits on a dark
chip, including in light theme. No icon mark exists; the prototype proposes app-icon options.

**Skins.** Inside a tournament everything recolours; Discover, Following, the pass wallet and the referee
console stay Move Score. A skin is two seed colours, artwork, logo and a light/dark preference. The palette is
generated from the seeds and contrast-checked when the admin saves it; live, warning and the ball marker are locked.

**Motion signature** (each communicates state; all respect Reduce Motion)

1. Score digits roll like a scoreboard, yellow sweep underneath, haptic tick.
2. The stage light swings toward the side that won the point.
3. The serve dot travels between players on a bounce arc.
4. Tab bar: the active marker is the ball, bouncing to the tapped tab. Pull-to-refresh is a ball toss.
5. Match card expands into the match screen.
6. Takeovers: SET POINT, MATCH POINT, TIE WON in the headline face, full screen, 1.5 s, with haptics.
7. Pass: sealed pack torn open by a swipe; tilt-reactive foil driven by the gyroscope.
8. Pins: enamel pin with a moving highlight and a "clink" haptic.
9. Momentum line drawing itself point by point.

**Show-off features**

| # | Feature | What it is |
|---|---|---|
| 1 | Event pass | Collectible pass per event. Scanning the QR at the venue upgrades it to the foil "On-site" edition and stamps each day. Attendees only (Oct 2026: no staff edition; staff access stays in the referee console). Scanning a match's check-in code (court TV corner or printed) records the match and adds points. Apple Wallet badge (Google Wallet hidden for now) |
| 2 | Share cards | Finished rubber or tie → branded 9:16 image for Stories, plus the share sheet |
| 3 | Lock-screen live score | iPhone Live Activity and Dynamic Island for a followed rubber. Android's version needs Android 16; after the event |
| 4 | Takeovers | On the live match screen, share button on the last frame |
| 5 | Nation supporter mode | Pick a nation: tint, flag on the pass, tap-to-cheer crowd meter per tie (no text input) |
| 6 | Nation pins | One per nation followed or watched on-site; binder on the profile |
| 7 | Momentum chart | From the point-by-point events already recorded |
| 8 | Recap | Wrapped-style story after the final; arrives by app update |

Not chosen: predict-the-tie. Parked: home-screen widget, "I'm at…" photo sticker, sponsor prize draw for on-site pass holders.

**Inspiration and what is taken from each**

| App | Borrowed |
|---|---|
| Apple Sports | One font at different widths for numbers; animated light gradient; tennis lock-screen layout |
| Sofascore | Wide headline / condensed table split; tabular figures |
| US Open | Blue court, yellow ball: yellow is the ball |
| Flashscore | No colour per sport or court; colour is for state |
| OneFootball | Motion intensity tied to match state |
| WHOOP | One hero number per screen; colour only for meaning |
| Nike Run Club | Neon on black for the single primary action |
| Luma | Per-event theme engine with light and dark; QR check-in feedback |
| DICE | A pass that changes state at the venue |
| Strava, Spotify Wrapped, Duolingo | Story-sized share cards; end-of-event recap |
| Pokémon TCG Pocket | Pack opening and tilt-reactive foil |
| Roland-Garros 2026 | Momentum chart |

## 5. Architecture

### 5.1 Repo and shared code
- App in `move-score-app/` (Expo SDK 57, dev builds, Expo Router, TanStack Query, EAS Build / Submit / Update).
- No web refactor. The app imports the pure engine through one barrel, `move-score-app/src/core/index.ts`,
  pointing at `../src/lib`: `types.ts`, `scoringLease.ts`, `sides.ts`, `standings.ts`,
  `scoring/{engine,rules,conduct}.ts`, `tennis/{ties,nations,placement,tieStandings}.ts` (all verified to import
  only relative paths). `metro.config.js` sets `watchFolders` and `nodeModulesPaths`. The first EAS build proves it.
- Web repo ignores the app: `tsconfig.json` exclude, `eslint.config.mjs` ignore, vitest `--dir src`,
  `.vercelignore`, Vercel ignored-build step.
- Device test for time zones (`tennis/ties.ts` uses `Intl` with `timeZone`).

### 5.2 Auth
- Staff: `POST /api/mobile/v1/staff/session {code}` → the existing HMAC role token in the body, 7-day life;
  `currentRole()` in `src/lib/auth.ts` accepts `Authorization: Bearer` then the cookie; timing-safe compare;
  rate limit with `src/lib/ratelimit.ts` (also on the web login).
- Users: Apple (iPhone, native sheet) sends its identity token to `POST /api/mobile/v1/auth/session`; Google
  runs Supabase's OAuth flow in the in-app browser sheet with PKCE (`GET auth/oauth/google` → Supabase →
  `movescore://auth/callback?code=`) and sends code + verifier to the same route. The server signs in with
  Supabase Auth using a per-request client (never the shared `db()` client) and returns the session; the
  Google button shows when `config.signIn.google` is true. Setup: `docs/google-sign-in.md`; `auth/refresh`; `DELETE /me` with Apple token revocation; a web deletion page for Play.
  No age question (removed with player codes). No Supabase key in the binary.
- Guests: `POST /api/mobile/v1/devices` registers an install id and push token and returns a signed install token.

### 5.3 Public read API (`/api/mobile/v1/…`)
- No auth header, no cookies, identical payload for everyone, so the CDN can cache it.
  `discover` (30 s), `t/{slug}/bundle` (60 s), `t/{slug}/live` (2 s, polled every 5 s), `matches/{id}` (1 s,
  polled every 3 s while live), `matches/{id}/timeline` (compact points for momentum), `t/{slug}/standings`,
  `config` (feature flags). Polling stops in the background. Personal data only under `/me/*`, uncached.
- New projection `src/lib/mobile/projection.ts` (leave `src/lib/public.ts` as is; a test pins it).
- Schema: `event_groups`; `tournaments` gains `event_group_id, venue_name, city, country_code, timezone, starts_on, ends_on`; `announcements`.
- Web public pages switch from `force-dynamic` to `revalidate = 4`; server region moves to Dublin (`dub1`).

### 5.4 Native referee console
- expo-sqlite, one transaction per tap (event + state) before the UI updates; same wire format as the
  existing `events` route; states Online / Offline / Syncing / Pending / Conflict always visible.
- New `GET /api/mobile/v1/referee/matches/{id}/bootstrap`: resolved rules, nominees, snapshot, last 50 states
  (so a phone that takes over can undo).
- Lease reused as is; keep-awake; re-claim on foreground.
- Must match `ScoreClient.tsx` feature for feature: who-serves-first, point confirmation, result
  confirmation, undo / reopen, pause, server switch, doubles serving player, tie-break and match tie-break,
  deciding point, changeover and set-break clock, code violations, end set, force end / walkover /
  retirement / DQ, plus `ControlPanel.tsx` and the "waiting for line-ups" state.
- Server hardening in `src/app/api/matches/[matchId]/events/route.ts`, web client unaffected: compute the
  last applied number from the events table as well as the snapshot; run reopen checks before inserting;
  finalise on retry if the snapshot says the match is over; whitelist event types; winner must be one of the
  two teams; batch cap. New `src/lib/scoring/shadow.ts` recomputes with the shared engine and logs
  mismatches without rejecting.
- Fallback to web mid-match: sync until nothing is pending, release, open the web console. If the phone
  cannot sync: "Hand over", wait 15 s, claim on web, re-enter the unsynced points by hand.

### 5.5 Notifications
- Tables: `push_devices`, `follows` (owner = user or install; target = player, nation, tie, match, event;
  starred matches live here), `notification_events` (unique dedupe key), `notification_deliveries`
  (one row per event per device, which is what collapses duplicates).
- One `enqueueNotification()` call in each existing hook: `scheduleTie`, `delayOrderOfPlay`, `lockLineups`
  (`src/lib/tennis/tieOps.ts`), `updateMatchSchedule` (admin matches `actions.ts`), `MATCH_STARTED` in the
  events route, `finalizeMatch` (`src/lib/ops.ts`), `applyTieResult`.
- Sender: a protected drain route, kicked immediately after each hook; timed reminders from a database cron
  job (free Vercel cron is daily only).
- Times in alerts use `tournaments.timezone`.

### 5.6 Lock-screen live score (#3)
- `expo-widgets`; one activity per rubber; the app updates it while open; the server pushes on game, set and
  match changes straight to Apple (`.p8` key), not through Expo.
- Two-day spike on 12–13 October. If a pushed update is not working on a real iPhone by then, it ships
  switched off and is finished after the event. The widget target is in the binary either way.

### 5.7 Pass, stamps, pins, cheers
- Tables: `event_passes`, `pass_stamps`, `pass_pins`, `tie_cheers`, `pass_attendances`, `pass_points` (0019).
- The pass is the attendee's only. Personal calls never carry the referee console's staff token (the bug that
  turned a tester's pass into "Referee · All courts"); the server ignores it and 0019 reset the old rows.
- Match check-in: `https://<site>/m/<match>?c=<8>` (court TV corner, rotates every 60 s, current + previous
  accepted) or `?p=<10>` (printed per match from the admin ties page, `/qr/match/<id>`); HMACs of
  VENUE_QR_SECRET like the venue code. `POST /api/mobile/v1/matches/{id}/checkin` (contract `MCheckInReply`):
  once per pass per match, open from 20 min before the match's time (or "ready") until 30 min after it ends,
  30 tries per phone per 10 min; it also unlocks on-site and stamps the day. Points (`src/lib/pass/attendance.ts`):
  10 a match, +10 at a final, +5 at a deciding rubber. Known limit: the TV code is on a public page, so it
  proves "looking at the court screen", not presence; fine for a light mini-game.
- Pass card: width = screen − 2 × 18 gutters (max 420 phone / 460 tablet), height × 1.58, prototype layout scaled.
- Venue QR: a link whose code rotates every 30–60 s, shown on a gate tablet page
  (`src/app/venue/[event]/qr/page.tsx`); a photo of it posted online stops working. Printed posters use a daily staff-set code.
- Wallet passes are generated on the server and opened by link, so they can arrive after the store build.
  The "Add to Apple Wallet" badge shows on Apple devices when flag `apple_wallet` is on (default on);
  config `walletReady.apple` says whether certificates are set. The app HEADs the route, then hands the URL to
  Safari, which shows the Add Pass sheet; "not set up" gets a calm note. Google: `GOOGLE_WALLET_BUTTON = false`.
- Every native module any later feature needs is in the first store binary: Skia, Reanimated, Gesture
  Handler, camera, haptics, view-shot, sharing, Stories share, notifications, Apple and Google sign-in,
  SQLite, SecureStore, keep-awake, widgets, updates, Sentry. Features then switch on by app update and server flag.

### 5.8 Security gate, in order
1. Dump production; build staging from that dump; staging gets the closed posture from day one.
2. Migration `0015_close_open_access.sql`: for every public table enable RLS and drop `server_full_access`;
   drop the four `media_*` storage policies; revoke grants from `anon` and `authenticated`. Rollback file ready.
3. Run every E2E script and an upload on staging with the new secret key (`sb_secret_…`; legacy keys are being retired).
4. Production: set `SUPABASE_KEY` to the secret key, redeploy, confirm through a canary table and
   `/api/health/db` that the server really is on the new key. Only then apply 0015.
5. Prove it: the anon key reads nothing, cannot insert, cannot upload; `scripts/smoke.ts` passes; a TV, a
   public page, a referee point and a logo upload all work. Then rotate `AUTH_SECRET` and the access codes.

## 6. Build sequence

| Dates | Outcome |
|---|---|
| 1–4 Oct | **Interactive prototype for approval.** Play account created; Apple app record; Google Wallet issuer, Meta app id, Firebase project requested. Permission letter requested. Pull main, merge into the mobile branch. Expo skeleton with every native module; first EAS build proves the shared engine. First API endpoints. |
| 5–11 Oct | **Android closed-test build uploaded by 5 Oct, 15–20 testers opted in by 7 Oct.** First TestFlight. Security gate closed by 8 Oct. Events-route hardening, bearer auth, staff login. Spectator core: Discover, hub, ties → rubbers, live match, matches, players. Web: tie pages, cached pages, Dublin region. |
| 12–18 Oct | Referee console complete. Follows, alerts, push pipeline. Apple / Google sign-in and deletion. Live Activity spike (12–13 Oct). Event pass with pack-opening, venue unlock, stamps; share cards. **Binary freeze 18 Oct.** |
| 19–25 Oct | iPhone app to App Review (19–20 Oct; demo referee code in the notes). Apply for Play production access (20–21 Oct). Takeovers and other JS-only features by app update. **Venue rehearsal, then go/no-go for native scoring.** |
| 26 Oct–1 Nov | **Hosting decision from load-test numbers (26–27 Oct).** Play production submission. Wallet passes. Create the two real tournaments, skins, venue QR. Referee briefing. Deploy freeze 31 Oct. |
| 2–8 Nov | Event. Supporter mode, pins, momentum, recap arrive by app update if not already in. No production deploys during play. |
| After | Player claim on, Ads Manager, native admin / operator, web rebrand, Android live notifications, widget. |

**If time runs out**, features are dropped from the bottom of this list upward; the top three lines are never dropped:
security gate and events hardening → referee console and cached API → follows and basic alerts →
event pass → share cards → lock-screen score → takeovers → supporter mode → pins → momentum → Wallet → recap.

**Go/no-go for native scoring as primary** (all true after the rehearsal): hardening live for 5+ days with no
web regression; shadow-mismatch log empty; 6+ full rubbers scored natively including airplane mode, an app
kill and a handoff each way, ending identical to the server; the build on every referee phone; the
web-fallback drill done on court. If any fails, web is primary and native runs on one outside court.

## 6.1 Full roadmap by phase

Everything from `PRODUCT_PLAN.md`, everything chosen in this session and every parked idea has a phase here.
Nothing is left unassigned. "Update" means it can arrive by app update without a new store release.

### Phase 1 — first event (store build by 18 Oct, event 2–8 Nov)

| Area | In Phase 1 | How it ships |
|---|---|---|
| Foundations | Security gate; staging; events-route hardening; bearer auth and rate limits; cached public API; Dublin region; feature flags (`config`); Sentry crash reporting; event-day runbook and monitoring page | Backend |
| Discover | No-login launch; featured event group (both finals as one hero); live now, upcoming, past, all tournaments; demo events hidden | Store build |
| Tournament hub | Overview, ties → rubbers, all matches with filters and search, schedule by day and court, draw / placement, standings, results, nations, players, tournament and venue info, sponsors (existing main + footer sponsors, read-only), full event skin | Store build |
| Live match | Rolling score, serve dot, set columns, tie context, point timeline, last-updated state, paused / suspended states | Store build |
| Players | Directory with search and filters, player page (record, history, next match, singles / doubles), follow. No photos at this event | Store build |
| Following | Stars and follows as guest or signed in; Following feed (next for you, live now, updates); merge on sign-in | Store build |
| Alerts | Scheduled, rescheduled, court changed, line-ups, starting, live, finished, tie won; one alert per person per event; on/off per type; major announcements sent from the web admin | Store build |
| Accounts | Apple / Google sign-in, player codes, account deletion in app and on the web, privacy policy, terms, support page | Store build |
| Referee | Staff code login, match picker, full tennis and padel console, offline queue, lease and handoff, sunlight (light) theme, web fallback drill | Store build |
| Player layer | Player code claim and My Matches built, **switched off** | Store build, flag off |
| Themes | Light and dark everywhere; Reduce Motion; large text; screen-reader labels | Store build |
| Show-off 1 | Event pass: pack-opening, tilt foil, venue QR unlock, day stamps, match check-in points | Store build |
| Show-off 2 | Share cards for rubbers and ties: Instagram Stories + share sheet | Store build |
| Show-off 3 | iPhone lock-screen live score and Dynamic Island | Store build, on only if the 12–13 Oct spike passes |
| Show-off 4 | Big-moment takeovers | Update |
| Show-off 5–8 | Nation supporter mode and cheer meter; nation pins; momentum chart; end-of-event recap | Update, during event week |
| Wallet | Apple Wallet and Google Wallet versions of the pass | Update (server-generated) |
| Website | Tie and nation pages; cached public pages; admin for featured group, venue / dates / time zone, skin seeds, announcements, venue QR page | Backend |
| Stores | App Store (individual account); Google Play (personal account, closed test → production) | — |

### Phase 2 — after the event (November 2026 – early 2027), ordered by value

| Area | Item |
|---|---|
| Player layer | Switch player claim on for adult events; guardian-managed accounts for juniors; player photos with opt-in; operational alerts for the player's own matches; tournament-configurable player check-in |
| Sponsors | Ads Manager: campaigns, image and video creatives, placements (home, hub, live footer, schedule, results, splash, TV), scheduling, optional links with safe-URL checks, show / hide, live footer preview, impressions / clicks / CTR; sponsor prize draw among on-site pass holders; sponsor promotional push (opt-in only) |
| Staff access | Event-scoped access codes, named staff accounts, per-tournament roles (`tournament_role_grants`), expiring access |
| Native admin | Operations-first admin: teams and nations, selected edits, courts and times, match management, scoring oversight and lock release, settings, announcements, featured control |
| Native TV operator | Screen list, modes, pinned court, coverage, break countdown, holding, ceremony, sponsor rotation |
| Referee | Chess scoring in the app; voice umpire in the app; dedicated tablet / landscape layouts; one-transaction score apply in the database; server rejects (not just logs) invalid states |
| Other formats | Friendly sessions and player rankings (Americano / Mexicano, fire streaks) in the app |
| Lock screen and widgets | Android live notification (Android 16); home-screen widgets on both platforms; one push per match for all followers (iOS broadcast channels) |
| Engagement | Predict-the-tie with fan leaderboard and gold passes; "I'm at…" photo sticker; richer alert preferences; follow a tournament; follow a player across events; better search |
| Brand | Website rebrand to Move Score black and yellow; vector logo and final app icon everywhere |
| Analytics | Product analytics (PostHog) with consent rules for minors; sponsor reporting exports |
| Platform | Move Google Play to an organization account; device attestation (App Attest, Play Integrity); legacy key removal; `DECISIONS.md` and spec brought in line |
| Tournament creation | Full tournament creation and draw editing from the phone |

### Phase 3 — longer term

| Area | Item |
|---|---|
| Languages | Arabic and right-to-left layout; further languages |
| Sports | More rulesets on the same engine; athlete career profiles; season-wide and club following |
| Tickets and access | Real ticketing and accreditation with scanning at the gate; venue maps |
| Media | Livestream links and embeds; vertical highlights feed; broadcaster overlays; photo "moment" gallery (adult events only) |
| Data | Federation and ranking feeds; match insights (keys to the match, win likelihood); club and academy integrations |
| Commercial | Sponsor CRM exports; white-label event apps on the same binary |
| Devices | Apple Watch and Wear OS score glance; TV app for venue screens |
| Fan extras | Player autograph on a fan's pass; trading of pins; season recap |

## 7. Risks the owner should see

- **R1 Free hosting.** The free Vercel plan includes 1,000,000 requests a month and cached responses count.
  500 spectators refreshing every 5 s use about 360,000 an hour; the TVs and referee phones alone use about
  1.5 million over the week. The plan also forbids commercial use. The owner's decision is to measure and
  decide on 26 October; the upgrade itself takes minutes. Until then: Dublin region, cached feeds, and
  reminders from the database's own scheduler all work on free. Supabase free has no backups, so I take a
  manual dump before the security gate.
- **R2 Android on 1 November.** A new personal Play account needs 12 testers for 14 straight days, then up to
  a week for Google's approval, then normal review. With the first build on 5 October this is about even
  odds. Fallback: testers' track by join link, and the website.
- **R3 Native scoring as primary** replaces a rehearsed console with one that will have a week in the field.
  The go/no-go list above decides; expect web-primary as a real possibility.
- **R4 Scope** is more than four weeks for two. The drop order is the control.
- **R5 Event names** on an individual Apple account without a letter can be rejected in review.
- **R6** The 2026 ITF regulations PDF has not been read against the scoring rules.

## 8. Needed from the owner

1. This week: Play personal account created and verified; 15–20 testers' Gmail addresses.
2. Permission letter from the organiser or federation.
3. Vector source of the MOVESCORE wordmark; a choice of app icon from the prototype.
4. Bundle / package id (proposed `org.mbeg.movescore`); privacy, support and deletion pages on mbeg.org.
5. Meta developer app id (Stories sharing); Google Wallet issuer application; Firebase project.
6. Rehearsal date at the venue (target 24 October); who runs the gate tablet or prints the QR.
7. The 2026 regulations PDF.

## 9. First step after approval — the interactive prototype

One self-contained page in a phone frame, published as a private artifact, using the cut-out wordmark and the
§4 tokens. Screens: Discover (two-event hero), tournament hub with tie → rubbers, live match (rolling digits,
serve dot, stage light, takeover, momentum line), players and follow, the event pass (pack-opening, tilt
foil, on-site stamp, staff edition), a share card, the referee console. Controls beside the frame: light /
dark, skin (Move Score / boys' event / girls' event), headline font, app-icon options. The owner approves or
redirects the look there; tokens and motion specs then carry into the Expo app. Build of the app starts in
parallel on the non-visual parts (accounts, security gate, API).

## 10. Verification

- Prototype: tapped through in the browser pane at phone width in both themes and each skin; contrast of every token pair computed and listed.
- Security gate: the §5.8 step 5 checks, not the advisor.
- Backend: `npm run lint`, `npx tsc --noEmit`, `npx vitest run`, `npm run build`; `scripts/e2e/tennis-week.ts` and `scripts/smoke.ts` on staging.
- Scoring: the same rubber scored on native and on web produces identical event rows and snapshots; airplane-mode game; app kill with events pending; handoff both ways; native → web fallback.
- Scale: scripted load of 500 and 1,000 clients against the cached feeds on staging; cache-hit ratio, origin requests and Vercel usage recorded for the 26 October decision.
- Devices: recent and older iPhone, flagship and mid-range Android, a tablet; iOS Simulator for layout.

---

# Phase 1 build status (1 October 2026)

What exists now, how it was checked, and what only the owner can do. Everything is on
the `move-score-mobile` branch; nothing is merged into `main`, so the live site is
unchanged except for the additive database migration (below).

## Built and checked

| Area | What | Where | Checked |
|---|---|---|---|
| Design | Interactive prototype (Stage Light, both themes, skins, motion) | `design/prototype.src.html`, published as a private artifact | Tapped through in the browser |
| Brand | Wordmark cut from the supplied artwork; app icon, adaptive icon, splash, notification icon; Archivo Expanded / Condensed cut from Google's variable font | `assets/brand`, `assets/fonts` | Rendered on dark and light |
| Database | Migration 0015: event groups, venue / dates / time zone / skin on tournaments, announcements, devices, follows, alert outbox and deliveries, accounts, passes, stamps, pins, cheers, lock-screen tokens, player claim | `supabase/migrations/0015_move_score_mobile.sql` | **Applied to the live project** (additive, empty tables, same access posture as existing tables) |
| Security gate | Script to close the open access, with rollback, and `/api/health/db` to prove which key the server uses | `supabase/gate/` | Not applied (needs the secret key, see below) |
| Score sync hardening | Refuses unknown events and foreign teams; heals a snapshot left behind by a failed request; reopen checks before any write; finalises on retry; shadow-checks every point with the shared engine | `src/app/api/matches/[matchId]/events/route.ts`, `src/lib/scoring/eventGuard.ts` | Unit tests; full tennis-week E2E; app API E2E incl. a deliberately wrong point (logged, not stalled) |
| Auth | Bearer tokens for the app, timing-safe code check, rate-limited logins (web and app); Apple / Google sign-in through the server, refresh, account deletion with Apple revocation; player codes (`/me/player`, claim, photo); guest install tokens | `src/lib/auth.ts`, `src/lib/mobile/identity.ts`, `src/lib/auth/users.ts`, `api/mobile/v1/{staff,auth,me}` | E2E for codes, tokens, forged tokens. Apple / Google need provider setup |
| Public API | discover, bundle, live, standings, match (with engine-computed set / match / break point), timeline, ties, cheers, config — CDN-cacheable | `src/app/api/mobile/v1`, `src/lib/mobile/*` | E2E: shapes, no private fields, cache headers |
| Alerts | Outbox hooks in scheduling, line-ups, match start, finish, tie result, announcements; one alert per phone per event; Cairo-time wording; drain route + database cron template | `src/lib/notify/*`, `supabase/ops/notification_cron.sql` | E2E: outbox rows, one-phone dedupe, preference filtering |
| Lock screen | Server sender (direct Apple push) and the app's Live Activity | `src/lib/notify/apns.ts`, `move-score-app/src/live` | Not on a device yet (flag `live_activity` off) |
| Pass | Pass (attendees only), serials, rotating venue code + daily staff code, stamps, pins, match check-in codes and points, Wallet generators, gate tablet page | `src/lib/pass/*`, `/venue/[slug]/qr`, `/v/[slug]` | E2E: unlock, stamp, wrong code, never a staff pass, check-in (TV, printed, expired, too early, closed, final + deciding = 25). Wallet needs certificates |
| Web | Public Ties page with nations and flags; public pages cached (4–10 s) instead of rendered per visit; region pinned to Dublin; admin App tab (venue, dates, time zone, skin, event group + featured, announcements, player codes); match times entered in event time | `src/app/t/[slug]/(public)`, `src/app/admin/tournaments/[id]/app`, `vercel.json` | Build, lint, 624 tests, tennis-week E2E |
| App | Expo SDK 57: Discover, hub (ties / groups / nations), tie (crowd meter), live match (rolling score, serve ball, stage light swing, momentum, game feed, takeovers), matches, players, player page, following, pass (pack opening, tilt foil, QR, stamps, pins), venue scanner, share cards (Stories + share sheet), account (alerts, theme, motion, sign-in, deletion), referee (code, picker, full console on SQLite with lease handoff, sunlight mode, hand-over) | `move-score-app/src` | Type-check clean; web build driven headlessly: browse, open pass, live match, referee signed in and scored 3 points that reached the server with 0 engine mismatches |
| Shared logic | Console actions shared with the web console's behaviour | `src/lib/scoring/console.ts` | Unit tests |

## Not yet done (by the owner, or blocked)

1. **Free disk space on the Mac.** The iOS build stopped with "No space left on device" (about 200 MB free). Free at least 15 GB (Xcode's DerivedData alone is 4.2 GB), then:
   `cd move-score-app && APP_ENV=development npx expo run:ios`
2. **Close the database gate**, in this order: copy the project's secret key (Supabase → Settings → API keys) → set `SUPABASE_KEY` in Vercel for Production and Preview → redeploy → open `/api/health/db` and wait for `"key":"secret"` → run `supabase/gate/close_open_access.sql` in the SQL editor → run `scripts/smoke.ts`. Rollback: `supabase/gate/reopen_open_access.sql`.
3. **Accounts to create this week:** Google Play (personal; add 15–20 testers' Gmail addresses), Expo account + EAS project (`npx eas-cli init`, then set `EAS_PROJECT_ID`), Firebase project for Android push (`google-services.json`), Apple: app record, Sign in with Apple key, APNs key, Pass Type ID certificate; Google Cloud OAuth web client for Supabase (see `docs/google-sign-in.md`; no iOS/Android clients needed); Meta app id for Stories; Google Wallet issuer. Put each value in Vercel / EAS env (names in `.env.example` and `app.config.ts`).
4. **Supabase Auth:** enable Apple (client id = bundle id) and Google (web client id + secret), and add `movescore://auth/callback` to the redirect URLs — exact list in `docs/google-sign-in.md`.
5. **Vercel:** add `CRON_SECRET`; apply `supabase/ops/notification_cron.sql` with the site URL and that secret.
6. **First builds:** `npx eas-cli build --profile production --platform android` → upload to the Play closed test **by 5 October**; same for iOS → TestFlight.
7. **Set up the event** in admin → App tab: event group "Junior Team Finals 2026", featured order 1, venue, dates, Africa/Cairo, skin colours; then print or open `/venue/<event>/qr` on the gate tablet.
8. **Merge** `move-score-mobile` into `main` when reviewed. It changes the live site: the cached public pages, the Ties page, the admin App tab, the hardened scoring route and the Dublin region. Do it on a quiet day and watch a referee point and a TV afterwards.
9. Still pending from §8 of the review: the permission letter, the regulations PDF, the rehearsal date.

## Developer notes

- Local stand-in: `npm run localdb`, then `npx next start -p 3077` with `.env.localdb`, then `npm run localdb:seed-app` for a featured demo event with live rubbers. App against it: `EXPO_PUBLIC_API_BASE_URL=http://localhost:3077 npx expo start --web --port 8099` (or the `move-score-web` launch config).
- App API check: `npm run e2e:mobile-api` (local stand-in).
- Feature flags live in `platform_settings` key `flags` (live database): `player_claim`, `live_activity`, `takeovers`, `supporter_mode`, `pins`, `momentum`, `wallet`, `recap`, `share_stories`, `accounts`. Turning one on needs no app release.
- The end-of-event recap (Phase 1 "by update") is not built yet; it ships by app update during event week.

---

# Appendix: the original master plan (30 September 2026)

Kept for reference. Where it conflicts with the sections above, the sections above win (see "Corrections to PRODUCT_PLAN.md").

## Move Score — Mobile Application, Web Evolution, Development & Production Master Plan

> **Single source of truth for product, design, engineering, QA, release, and event operations**
>
> Repository: `WahidEcho/MB-Padel-Tour-managment`  
> Working branch: `move-score-mobile`  
> Native app folder: `move-score-app/`  
> Product name: **Move Score**  
> Primary launch event: **Junior Tennis Team Finals, Cairo 2026**  
> Hard public-availability target: **1 November 2026**  
> Initial launch scale assumption: **up to 1,000 concurrent spectators and 20 active courts**

---

## 0. Document status

This document replaces fragmented planning notes for the Move Score mobile application and its required web/backend evolution.

It contains:

- product vision;
- locked product decisions;
- role definitions;
- public audience experience;
- match-interest system;
- player-follow system;
- player account/claim system;
- referee experience;
- admin and TV operator scope;
- sponsor/Ads Manager scope;
- design direction;
- Figma structure;
- technical architecture;
- code-sharing strategy;
- database changes;
- API design;
- authentication and permissions;
- offline scoring;
- realtime/public-read strategy;
- notification system;
- analytics and monitoring;
- security hardening;
- testing strategy;
- performance budgets;
- accessibility requirements;
- store-readiness work;
- release plan;
- event rehearsal plan;
- production runbook;
- incident handling;
- acceptance criteria;
- Phase 2/3 roadmap;
- known gaps and pending external inputs.

If a future product decision conflicts with this file, update this file first and then change code/tests/designs to match.

---

## 1. Product vision

Move Score is not only a scoring screen and not only a padel tournament manager.

It is intended to become a **multi-sport tournament operating system and live spectator product** with five connected layers:

1. **Audience layer**
   - tournament discovery;
   - all matches;
   - live scoring;
   - schedules;
   - brackets/draws;
   - standings;
   - results;
   - teams;
   - players;
   - player following;
   - interesting matches;
   - tournament information;
   - major announcements;
   - sponsors.

2. **Player layer**
   - player identity;
   - My Matches;
   - upcoming matches;
   - ranking;
   - statistics;
   - match history;
   - draw position;
   - notifications;
   - optional check-in in future/event-specific configurations.

3. **Referee layer**
   - access-code entry;
   - match selection;
   - offline-first scoring;
   - direct score correction/undo;
   - reliable synchronization;
   - result confirmation according to tournament settings.

4. **Tournament operations layer**
   - teams/nations;
   - players;
   - scheduling;
   - courts;
   - ties/rubbers;
   - match generation;
   - settings;
   - score oversight;
   - announcements;
   - sponsor controls;
   - TV operation.

5. **Commercial/sponsor layer**
   - main sponsor;
   - footer sponsors;
   - image/video creatives;
   - visibility controls;
   - scheduling;
   - sponsor links;
   - live previews;
   - impressions/clicks;
   - tournament-specific campaign reporting.

The long-term architecture must support more sports without requiring a new application for each sport.

---

## 2. Product principles

### 2.1 Backend is the source of truth

The current Move Score web backend remains authoritative.

The native app must **not create a parallel scoring model, tournament database, or sponsor model**.

Mobile reflects and operates the same tournament state as web.

### 2.2 Public experience first

A spectator should be able to open Move Score and immediately understand:

- what is happening live;
- what tournament is featured;
- what matches are on;
- what matches are next;
- who is playing;
- who they follow;
- what they have marked interesting.

No login should be forced before tournament discovery.

### 2.3 Reliability before visual extras

If a choice must be made between:

- a new decorative feature;
- or better offline/recovery/scoring integrity;

reliability wins.

### 2.4 Tournament skin over application redesign

Move Score should have a stable product identity.

Each event may provide:

- event logo;
- event colors;
- event imagery;
- competition artwork;
- sponsor system;
- background;
- light/dark preference.

The navigation and interaction language remain Move Score.

### 2.5 Roles are capabilities, not completely different products

The application is one product.

Roles determine what the user can access.

The public audience experience always remains accessible.

### 2.6 Every critical mutation is auditable

Critical changes must record who, what, when, and before/after state where appropriate.

This includes:

- scores;
- match result correction;
- draw edit;
- court/time edit;
- role changes;
- tournament-setting changes;
- sponsor visibility changes;
- player account linking.

---

## 3. Existing repository audit — what already exists

The existing repository is already a strong foundation.

Current stack:

- Next.js 16;
- React 19;
- TypeScript;
- Tailwind;
- Supabase/PostgreSQL;
- Supabase Storage;
- server-side database access;
- Vitest;
- IndexedDB/Dexie for web referee offline queue.

Current relevant capabilities already in the repository include:

### 3.1 Roles

Current type:

`admin | manager | referee | operator`

Current login flow uses access codes to select the role.

### 3.2 Sports

Current type includes:

- padel;
- chess;
- tennis.

The new app should preserve sport extensibility.

### 3.3 Tournament core

Current tournament model includes:

- name;
- slug;
- sport;
- kind;
- status;
- branding_config;
- scoring_config;
- format_config;
- court_config;
- lower-third text;
- public-access control.

### 3.4 Tennis

The current repository already supports:

- tennis scoring;
- singles/doubles differentiation;
- best-of-three structures;
- advantage/no-ad options;
- match tie-break options;
- nation/team competitions;
- ties;
- rubbers;
- group ties;
- placement ties;
- line-up logic;
- tie standings;
- court/time assignments;
- dead-rubber behavior;
- TV tennis scenes;
- tennis E2E tests.

### 3.5 Scoring

Current architecture already includes:

- event-sourced scoring;
- `score_events`;
- `match_score_snapshots`;
- ordered score events;
- score transitions;
- offline scoring on web;
- score-device locking/control;
- score-control lease;
- conflict handling;
- audit logs;
- result confirmation setting;
- walkover;
- retirement;
- disqualification;
- force end;
- pause/resume;
- undo;
- serve handling;
- tie-break support.

The native app should reuse the pure TypeScript scoring engine/rules but must replace browser storage with native durable storage.

### 3.6 Public web

Current public pages include:

- tournament overview;
- leaderboard;
- live;
- bracket;
- winner;
- match page;
- matches.

These public pages are an important fallback and should evolve alongside the native app.

### 3.7 TV / operator

Current system includes:

- operator role;
- screen settings;
- live court mode;
- leaderboard mode;
- bracket mode;
- ceremony;
- sponsor mode;
- holding state;
- per-screen coverage;
- break countdown;
- pinned court;
- theme;
- sponsor rotation;
- multi-screen control.

### 3.8 Sponsors

Current branding structure includes:

- Move Beyond logo;
- client logo;
- event logo;
- event background;
- main sponsor;
- sponsor accent;
- sponsor intensity;
- footer sponsor list;
- sponsor chips;
- sponsor size logic;
- public sponsor band;
- TV sponsor band.

This remains useful but must be expanded into a real campaign/Ads Manager.

### 3.9 Existing launch risk documented in repository

The existing go-live document identifies a critical security task:

- current broad anonymous Supabase policies must be closed before any client-side credential is allowed to access the database.

This is a **hard launch gate** for native release.

---

## 4. Application information architecture

Recommended bottom navigation for public/user mode:

1. **Discover**
2. **Matches**
3. **Players**
4. **Following**

A profile/avatar/login entry remains in the top-level header or account sheet.

When a user has a role such as referee/admin/operator, role tools are entered from the profile/role switcher rather than replacing the public application entirely.

Example:

```text
Move Score
├── Discover
├── Matches
├── Players
├── Following
└── Account
    ├── Player Profile
    ├── Referee Mode
    ├── Admin Mode
    ├── TV Operator
    └── Settings
```

---

## 5. Audience experience

### 5.1 No-login first launch

The first app screen must not be a login form.

The user opens Move Score and sees:

1. Move Score identity;
2. featured/live tournament;
3. live matches;
4. upcoming tournaments;
5. past tournaments;
6. access to all tournaments.

Login is optional.

### 5.2 Featured tournament behavior

Add a **platform-level featured tournament setting** controlled from the web admin.

Recommended model:

`platform_settings.featured_tournament_id`

Do not implement this as many independent `is_featured` booleans unless a future product decision requires multiple simultaneous hero events.

Behavior:

- one tournament can be featured;
- featured tournament takes hero priority on both app and public web;
- if the featured tournament is live/active, it appears first;
- other tournaments remain discoverable;
- secondary tournaments may be collapsed under “All tournaments”;
- upcoming and past sections still remain;
- clearing the featured value returns normal ordering.

The setting must take effect on:

- native app;
- web public landing page;
- any future public discovery surface.

### 5.3 Tournament sections

Discover page sections:

- Featured now;
- Live now;
- Upcoming;
- Past;
- All tournaments.

Tournament card fields:

- name;
- logo/artwork;
- sport;
- city/venue;
- date range;
- state: Upcoming / Live / Completed;
- number of live matches when active;
- sponsor presence if required;
- call to action.

### 5.4 Tournament hub

Each tournament hub can include:

- Overview;
- Live;
- Matches;
- Schedule;
- Draw/Bracket;
- Standings/Rankings;
- Results;
- Teams/Nations;
- Players;
- News/Announcements;
- Tournament info;
- Venue info;
- rules if organizers want them public;
- streaming links if supplied;
- sponsors.

Visibility should be configurable per tournament.

---

## 6. All Matches experience

Attendees must be able to see **every public match in the tournament**, not only live matches.

### 6.1 Filters

Required filters:

- All;
- Live;
- Upcoming;
- Completed/Results;
- Interesting;
- Day/date;
- Court;
- Round/stage;
- team/nation;
- player;
- singles/doubles where applicable.

Search should support:

- player name;
- team/nation;
- court;
- match identifier.

### 6.2 Match cards

Match card should show:

- scheduled time;
- current status;
- court;
- stage/round;
- team/player A;
- team/player B;
- country/flag when relevant;
- current score or final score;
- “Interesting” control;
- live indicator;
- delay/paused state if applicable.

### 6.3 Interesting matches

Attendees can mark any public match as **Interesting**.

Recommended UX term in English:

- default: `☆ Mark interesting`
- selected: `★ Interesting`

Alternative copy may later become `Save match`, but “Interesting” is currently the product term.

#### Guest behavior

No login required.

Store interesting match IDs in local native storage.

Guest saved matches:

- persist across app restarts;
- do not automatically move to another phone;
- may be lost after uninstall.

#### Logged-in behavior

When logged in:

- save to backend;
- sync across devices;
- merge existing local guest interests after login.

Recommended merge rule:

`server interests ∪ local interests`

Do not delete either side silently.

### 6.4 Interesting match notifications

Recommended V1:

- an interesting match may opt into:
  - schedule created;
  - court/time changed;
  - match starting;
  - final result.

To avoid notification overload, default behavior can be:

- court/time changes;
- match starting.

Result notification may be configurable.

This is separate from the global “major tournament announcements” channel.

---

## 7. Player directory & following

### 7.1 Public player directory

Everyone can browse all public players.

No account is required to view player data.

Player list should support:

- search;
- A–Z;
- team/nation;
- tournament;
- followed only;
- currently playing;
- upcoming today.

Player row should show:

- name;
- flag/team;
- tournament;
- next match;
- status;
- Follow button.

Private data must never be shown publicly.

Do not expose:

- phone;
- email;
- access code;
- internal notes;
- private admin fields.

### 7.2 Player detail page

Public player detail may show:

- full name;
- public photo/portrait when available;
- nation/team;
- current tournament;
- next match;
- tournament record;
- wins/losses;
- sets/games where appropriate;
- match history;
- current draw/placement;
- ranking/standing;
- live indicator if playing;
- Follow button.

For tennis team competitions, the player page should distinguish:

- singles appearances;
- doubles appearances.

### 7.3 Follow players

The follow system is a core audience feature, particularly for:

- parents;
- siblings;
- extended family;
- friends;
- coaches/supporters;
- fans following a specific athlete.

#### Recommended rule

Browsing does not require login.

**Server-backed player following does require a lightweight account** because push subscriptions must reliably persist and follow the user across devices.

A guest may optionally keep local-only followed players, but reliable player notifications should be enabled after login.

Recommended flow:

```text
Tap Follow
    ↓
If logged in → follow saved immediately
    ↓
If guest → offer:
    Keep on this phone
    OR
    Sign in to get alerts everywhere
```

For V1, simplest production rule may be:

- guest can locally follow;
- push alerts prompt user to sign in.

### 7.4 Player-follow notification events

Followers should be eligible for notifications when:

1. player receives a new match assignment;
2. match schedule is changed;
3. court is changed;
4. match is moved/delayed;
5. match is about to start;
6. match status becomes live;
7. match finishes;
8. result is published.

Recommended defaults:

- schedule assigned: ON;
- schedule changed: ON;
- starting: ON;
- result: ON.

Users may later individually disable types.

### 7.5 Duplicate notifications

If a user:

- follows both players in the same match;
- and also marks the match Interesting;

the system must send **one consolidated notification**, not three.

Deduplication key can use:

`user/device + match_id + notification_event_type`

---

## 8. Following feed

The Following tab should aggregate personal tournament tracking.

Recommended sections:

### 8.1 Next for you

Chronologically ordered:

- followed-player upcoming matches;
- interesting matches.

### 8.2 Live now

Live matches containing:

- a followed player;
- an interesting match.

### 8.3 Player updates

Examples:

- Adam Hassan — Court changed to Court 2;
- Jun Sato — won 6–3, 6–4;
- Mateo Lopez — next match tomorrow 10:00.

### 8.4 Following list

Separate views:

- Players;
- Matches;
- Tournaments if tournament-following is added.

---

## 9. Notifications system

Notifications are divided into three categories.

### 9.1 Global tournament announcements

Available without player following.

Examples:

- event started;
- group stage ended;
- quarter-finals ready;
- semi-finals ready;
- final ready;
- country/team wins;
- major manual organizer announcement.

Avoid over-notifying.

### 9.2 Personal match/player notifications

Triggered by:

- followed players;
- interesting matches.

Events:

- scheduled;
- rescheduled;
- court changed;
- delayed;
- starting;
- live;
- final result.

### 9.3 Operational player notifications

Authenticated player account receives:

- own match scheduled;
- own court changed;
- own time changed;
- own match starting;
- important tournament operations.

These should be prioritized higher than general audience notifications.

### 9.4 Sponsor pushes

Not in Phase 1.

Phase 2 only.

If implemented, sponsor pushes must:

- be explicitly enabled;
- respect notification preferences;
- be clearly promotional;
- not be mixed with safety/operational scoring notifications.

---

## 10. Player account experience

### 10.1 Player profile claim

Current players already exist in tournament data.

Create a **Player Code** flow.

Flow:

```text
Create account
↓
Enter one-time player code
↓
Resolve persistent player profile
↓
Confirm
↓
Link user account ↔ player profile
↓
Invalidate code
```

Admin can also manually assign a user account to a player.

### 10.2 Player code rules

Player code should be:

- random;
- one-time or revocable;
- stored hashed server-side;
- never logged in analytics;
- rate limited;
- invalidated after successful claim;
- regenerated by admin if necessary.

Do not use predictable codes based only on:

- player name;
- date of birth;
- tournament ID.

### 10.3 Junior accounts

For current scope:

- juniors may have their own accounts;
- no parent/guardian account linking is required in V1.

Future child/guardian features can be considered separately if required.

### 10.4 My Matches hierarchy

Player home priority:

1. Next/upcoming match;
2. Ranking/standing;
3. Statistics;
4. Further upcoming matches;
5. Recent results;
6. Match history;
7. Draw/tournament context;
8. team details;
9. profile.

The next match should be visually dominant.

### 10.5 Player check-in

Product can support player check-in, but it is tournament-configurable.

For the Junior Tennis Team Finals scoring scope:

- player check-in is OFF;
- Move Score is not responsible for event player check-in.

---

## 11. Referee experience

### 11.1 Authentication

Phase 1:

- referee access code.

A referee can see all tournament matches in current internal-team operation.

Future Phase 2:

- event-scoped codes;
- event-scoped roles;
- user can have different roles per tournament;
- one code must not give permanent access to all events.

### 11.2 Match picker

Referee match list should show:

- tournament;
- date;
- court;
- time;
- teams/players;
- stage;
- match status;
- current scoring-device status;
- pending-sync warning if any.

Filters:

- live;
- ready;
- upcoming;
- court;
- tournament.

### 11.3 Scoring console

Must be optimized for:

- one-hand/two-hand use;
- bright outdoor conditions;
- personal iPhones;
- personal Android devices;
- tablets/iPads;
- unstable mobile internet.

Primary score controls must be extremely large.

No important scoring action should depend on a tiny icon.

### 11.4 Score correction

Referee can undo score events without admin approval because mis-taps are expected during live operation.

Sensitive actions may still require confirmation, including:

- retirement;
- walkover;
- DQ;
- force end.

### 11.5 Result confirmation

Already represented by existing tournament scoring configuration.

Tournament setting:

`requireResultConfirmation`

When on:

- winning point produces provisional final state;
- referee confirms result;
- undo remains possible before confirmation.

When off:

- winning point finalizes directly.

### 11.6 Audit

Every relevant referee event should carry:

- match;
- tournament;
- device;
- actor/role;
- local event ID;
- server event ID;
- timestamp;
- sequence;
- old state;
- new state;
- event type.

---

## 12. Native offline scoring architecture

Offline scoring is mandatory.

Referees are expected to use:

- personal phones;
- iOS or Android;
- primarily SIM/mobile data;
- occasional Wi-Fi.

### 12.1 Existing web model

Current web referee uses IndexedDB/Dexie.

This cannot be reused directly in React Native.

### 12.2 Native storage

Use durable SQLite in native app.

Recommended:

- Expo SQLite or equivalent native SQLite layer.

Do not rely only on:

- in-memory state;
- AsyncStorage for critical ordered score events.

### 12.3 Local event table

Recommended local schema:

```text
score_event_queue
- local_id
- match_id
- tournament_id
- device_id
- client_sequence
- event_type
- payload_json
- previous_state_hash
- created_at_device
- sync_status
- server_event_id
- last_error
- retry_count
```

Possible `sync_status`:

- queued;
- syncing;
- acknowledged;
- conflict;
- error.

### 12.4 Sync flow

1. Claim/control match.
2. Fetch authoritative state and latest server sequence.
3. Persist control/session details.
4. User scores a point.
5. Apply transition locally using shared scoring engine.
6. Persist score event to SQLite **before treating it as durable**.
7. Update UI immediately.
8. Attempt sync.
9. Server validates device/control and sequence.
10. Server appends score event.
11. Server updates authoritative snapshot.
12. Server returns acknowledgment/server event ID.
13. Mark local event acknowledged.
14. Continue.

### 12.5 Reconnect

When network returns:

- send pending events in order;
- never reorder;
- stop on conflict;
- do not silently skip a rejected event.

### 12.6 Visible network states

Referee UI must show:

- Online;
- Offline;
- Syncing;
- Pending Sync;
- Sync Error;
- Conflict.

Referee should always know whether a score is safely on the server.

### 12.7 App termination

If the app is killed:

- queued score events remain in SQLite;
- reopening reconstructs match state from authoritative snapshot + pending local events where safe;
- user is told if pending events still require sync.

### 12.8 Device handover

If referee phone dies:

1. admin/operator releases scoring control;
2. second device claims match;
3. authoritative server snapshot is loaded;
4. second device continues.

Never allow two devices to independently score the same match without explicit control transfer.

---

## 13. Tennis team competitions

### 13.1 Parent tie + child rubbers

Support both views.

Parent:

- nation/team vs nation/team;
- tie score;
- overall status.

Children:

- singles 2;
- singles 1;
- doubles.

Spectators normally enter the tie, then can open each rubber.

Referee scores an individual rubber.

Admin manages both.

### 13.2 Current rules

Repository contains current assumptions and tests for the Cairo junior team format.

However:

- final official event regulations remain authoritative;
- if final regulations differ, update this master plan and rules/tests.

### 13.3 Dead rubbers

Behavior remains tournament-format controlled.

Current implementation already distinguishes group vs placement behavior.

---

## 14. Mobile admin scope

### 14.1 Phase 1 operational admin

Include:

- tournament list;
- tournament dashboard;
- teams/nations;
- team details;
- selected team/player edits;
- tournament settings;
- scoring settings;
- match list;
- generate/manage matches where existing APIs allow;
- courts/times;
- referee oversight;
- score oversight;
- announcements;
- sponsor controls;
- featured-tournament control if appropriate;
- TV/operator entry.

### 14.2 Draw edits

Admin only.

No referee/operator draw editing.

### 14.3 Full tournament creation

Phase 2.

Do not jeopardize first-event reliability by attempting full web parity in the initial native release.

---

## 15. TV Operator

Operator remains distinct from referee.

TV operator responsibilities:

- choose screen;
- choose scene/mode;
- pin court;
- select covered courts;
- break countdown;
- holding;
- leaderboard;
- bracket;
- ceremony;
- sponsors;
- animations/mute;
- sponsor rotation.

Operator does not score matches.

---

## 16. Web platform changes required for mobile

The native app cannot be treated as an isolated code folder.

The web platform must gain shared controls/APIs.

Required web changes:

### 16.1 Platform discovery settings

- featured tournament selection.

### 16.2 Public APIs

Need clean read endpoints/contracts for:

- tournament list;
- featured tournament;
- tournament hub;
- matches;
- live matches;
- players;
- player detail;
- standings;
- brackets;
- sponsors;
- announcements.

### 16.3 Authenticated APIs

Need endpoints/contracts for:

- player profile claim;
- follows;
- interesting matches;
- device push subscriptions;
- notification preferences.

### 16.4 Role mutation APIs

Need protected endpoints for:

- referee scoring/control;
- admin operations;
- operator screen controls.

Native app must not perform arbitrary direct table writes.

### 16.5 Ads Manager

New web admin module for sponsor campaigns and live footer preview.

---

## 17. Sponsor / Ads Manager

### 17.1 Existing sponsor behavior to preserve

- main sponsor;
- main sponsor logo;
- accent/glow;
- intensity;
- sponsor footer;
- sponsor chips;
- sponsor uniform sizing;
- TV sponsor mode;
- public sponsor footer.

### 17.2 New campaign model

Recommended entities:

#### sponsor_campaigns

- id;
- tournament_id;
- sponsor_name;
- tier;
- status;
- starts_at;
- ends_at;
- click_enabled;
- destination_url;
- created_by;
- created_at;
- updated_at.

#### sponsor_creatives

- id;
- campaign_id;
- type: image | video | embed;
- source_url;
- thumbnail_url;
- aspect;
- duration_ms where relevant;
- alt_text;
- status.

#### sponsor_placements

- id;
- campaign_id;
- placement_key;
- active;
- sort_order;
- show_on_web;
- show_on_mobile;
- show_on_tv.

Possible placement keys:

- tournament_footer;
- mobile_home;
- tournament_home;
- live_match_footer;
- schedule;
- results;
- splash;
- full_screen_sponsor;
- TV_footer.

### 17.3 Tournament scope

Phase 1 targeting is by tournament.

Do not add user-personalized ad targeting.

### 17.4 Creative types

Support:

- uploaded image;
- uploaded video;
- embedded video/media where technically safe and allowed.

### 17.5 Sponsor links

Optional.

Setting can enable/disable clicks.

External links must:

- show clear destination behavior;
- use safe URL validation;
- open with native external-browser handling.

### 17.6 Sponsor visibility

Every sponsor/logo/campaign should have:

- Show;
- Hide.

Changes should update:

- web;
- mobile;
- TV surfaces where placement applies.

### 17.7 Live sponsor footer preview

Web Ads Manager must contain an accurate preview.

Preview should show:

- main sponsor;
- current footer order;
- hidden sponsors;
- chips/no chips;
- uniform/non-uniform sizing;
- active campaign timing.

### 17.8 Metrics

Phase 1 helpful metrics:

- impressions;
- clicks;
- CTR;
- placement;
- tournament;
- creative;
- platform/device class.

Do not count background polling as sponsor impressions.

Define an impression only when the sponsor placement is actually rendered/visible according to the implementation rules.

---

## 18. Data model additions

Exact SQL must be reviewed against current production schema before migration.

Recommended additions:

### 18.1 Platform settings

`platform_settings`

- key;
- value_json;
- updated_at;
- updated_by.

Use:

- `featured_tournament_id`.

### 18.2 User/application account

If Supabase Auth is adopted for public/player accounts:

- auth.users remains identity;
- application profile table maps public profile/preferences.

Recommended:

`app_users`

- auth_user_id;
- display_name;
- created_at;
- updated_at.

### 18.3 Player profile claim

Existing player profile forward-compatibility fields should be reused where possible.

Add:

`player_claim_codes`

- id;
- player_profile_id;
- code_hash;
- expires_at;
- used_at;
- revoked_at;
- created_by;
- created_at.

### 18.4 Player follows

`player_follows`

- user_id;
- player_profile_id;
- tournament_id nullable if global following is later allowed;
- created_at.

Unique constraint:

`user_id + player_profile_id + tournament scope`

Product decision for V1 should likely follow a player **within the tournament context**, while the architecture can later allow global follow.

### 18.5 Interesting matches

`match_interests`

- user_id;
- match_id;
- created_at;
- notify_schedule;
- notify_start;
- notify_result.

Guest interests remain local and do not require rows.

### 18.6 Device push subscriptions

`push_devices`

- id;
- user_id nullable;
- installation_id;
- expo_push_token / provider token;
- platform;
- app_version;
- enabled;
- last_seen_at;
- created_at.

### 18.7 Tournament announcement subscriptions

`tournament_subscriptions`

- device_id/user_id;
- tournament_id;
- major_announcements_enabled.

### 18.8 Notification events

`notification_events`

- id;
- event_type;
- tournament_id;
- match_id nullable;
- player_profile_id nullable;
- payload_json;
- dedupe_key;
- created_at.

### 18.9 Notification deliveries

`notification_deliveries`

- notification_event_id;
- device_id;
- status;
- provider_message_id;
- sent_at;
- opened_at;
- error.

### 18.10 Ads Manager tables

As defined in Sponsor section.

### 18.11 Role access Phase 2

Future:

`tournament_role_grants`

- tournament_id;
- role;
- code_hash/user_id;
- starts_at;
- ends_at;
- revoked_at.

This supports event-specific access codes.

---

## 19. API design

Names are recommendations; exact Next.js route placement may change.

### 19.1 Public

- `GET /api/mobile/discover`
- `GET /api/mobile/tournaments/:slug`
- `GET /api/mobile/tournaments/:slug/matches`
- `GET /api/mobile/tournaments/:slug/live`
- `GET /api/mobile/tournaments/:slug/players`
- `GET /api/mobile/tournaments/:slug/players/:id`
- `GET /api/mobile/tournaments/:slug/standings`
- `GET /api/mobile/tournaments/:slug/bracket`
- `GET /api/mobile/tournaments/:slug/announcements`
- `GET /api/mobile/tournaments/:slug/sponsors`

### 19.2 User

- `POST /api/mobile/me/player-claim`
- `GET /api/mobile/me`
- `GET /api/mobile/me/matches`
- `POST /api/mobile/me/follows/:playerId`
- `DELETE /api/mobile/me/follows/:playerId`
- `POST /api/mobile/me/interests/:matchId`
- `DELETE /api/mobile/me/interests/:matchId`
- `POST /api/mobile/push/register`
- `PATCH /api/mobile/push/preferences`

### 19.3 Referee

Reuse/adapt current match scoring endpoints:

- claim;
- state;
- events;
- lease renew;
- release lease;
- control request/response.

Native API contract should be versioned/stable.

### 19.4 Admin

Expose only explicit operations needed by V1.

Avoid a generic “table write” API.

### 19.5 Operator

Reuse/adapt screen control actions.

---

## 20. Authentication & authorization

### 20.1 Public audience

No authentication required.

### 20.2 Player/general user

Use proper application authentication for persistent follows/push preferences.

Recommended options:

- email magic link;
- email/password;
- phone OTP if commercial/provider setup is ready.

The exact V1 account method may be selected based on speed and store/privacy requirements.

Player identity is a separate claim step.

### 20.3 Referee

Access code Phase 1.

Do not mix referee role with spectator/player account unless role linking is explicitly implemented.

### 20.4 Admin/operator

Current access code system can remain for first internal event if security hardening is correct.

Future:

- named accounts;
- event-scoped roles;
- expiring access.

### 20.5 Server authorization

Every write must validate:

- authenticated/session role;
- tournament scope;
- action capability;
- match state if relevant.

Never trust a role sent by the client in a request body.

---

## 21. Supabase security hardening

Hard launch gate.

Before native production:

1. verify Vercel/server has correct secret/service credential;
2. confirm secret never ships to browser/native;
3. remove broad anon/authenticated full-access policies documented by current go-live file;
4. use explicit public read APIs;
5. keep mutation APIs server-side;
6. review RLS;
7. run Supabase security advisor;
8. run smoke/E2E after policy changes;
9. verify public pages still work;
10. verify referee offline sync still works.

Native binary must contain no credential capable of directly rewriting tournament tables.

---

## 22. Shared code strategy

Recommended folder direction:

```text
/
├── src/                        # current Next.js
├── move-score-app/             # React Native/Expo
├── packages/
│   ├── scoring-core/           # pure scoring engine/rules
│   ├── domain/                 # types/contracts
│   └── api-contracts/          # DTO/schema definitions
└── supabase/
```

Do not immediately force a large monorepo refactor before event launch.

Safe incremental approach:

1. identify framework-free modules;
2. copy/extract with tests;
3. preserve imports on web through a stable shared path;
4. validate web tests;
5. consume same package from mobile.

Priority reusable modules:

- scoring engine;
- scoring rules;
- tennis tie rules;
- stage-rule resolution;
- score-state/event types;
- domain types;
- sponsor helper logic that does not depend on DOM/server APIs.

Do not import:

- Next.js server actions;
- Node-only Supabase service code;
- browser Dexie code;

into native.

---

## 23. Native application stack

Recommended:

- React Native;
- Expo;
- TypeScript;
- Expo Router;
- TanStack Query for server state;
- lightweight state store only for local interaction/session state where needed;
- Expo SQLite for critical offline queues;
- SecureStore for secrets/session material;
- Expo Notifications;
- EAS Build;
- EAS Submit.

Pin exact versions at implementation time to compatible stable releases.

Do not upgrade core framework versions during final event hardening unless required for a critical fix.

---

## 24. Native folder structure

Suggested:

```text
move-score-app/
├── app/
│   ├── (public)/
│   │   ├── index.tsx
│   │   ├── matches.tsx
│   │   ├── players.tsx
│   │   ├── following.tsx
│   │   └── tournament/
│   ├── (auth)/
│   ├── player/
│   ├── referee/
│   ├── admin/
│   └── operator/
├── src/
│   ├── components/
│   ├── features/
│   │   ├── discover/
│   │   ├── matches/
│   │   ├── players/
│   │   ├── following/
│   │   ├── scoring/
│   │   ├── admin/
│   │   └── sponsors/
│   ├── api/
│   ├── offline/
│   ├── notifications/
│   ├── analytics/
│   ├── auth/
│   ├── theme/
│   └── utils/
├── assets/
├── app.config.ts
├── eas.json
└── package.json
```

---

## 25. Design system

### 25.1 Figma file

**Move Score Mobile**

Pages:

- 00 Product Brief
- 01 Foundations
- 02 Audience
- 03 Player
- 04 Referee
- 05 Admin & Operator
- 06 Ads Manager

### 25.2 Typography

Primary:

- **Manrope**

Use for:

- navigation;
- titles;
- body;
- buttons;
- editorial content.

Data/sports:

- **IBM Plex Sans Condensed**

Use for:

- scores;
- times;
- courts;
- rounds;
- data-heavy labels.

### 25.3 Visual direction

Desired:

- premium editorial event product;
- calm interface;
- sports broadcast precision;
- large event visuals;
- strong live states;
- low visual noise;
- generous spacing;
- subtle motion;
- high-quality typography.

Reference quality:

- Luma-like event hierarchy/spacing/polish;

but Move Score must remain visually original and sports-specific.

Avoid:

- generic purple/blue AI gradients;
- excessive glassmorphism;
- random glow;
- dashboard card overload;
- excessive rounded containers;
- decorative charts with no purpose;
- identical SaaS-template screen patterns.

### 25.4 Core palette

Current provisional system before final new logo is supplied:

- warm light base;
- near-black live/broadcast surfaces;
- Move Score red accent;
- live orange/red state;
- tournament skin colors as controlled secondary accents.

Final logo may adjust the primary accent without rebuilding the component hierarchy.

### 25.5 Audience Figma flow already started

Core screens:

1. Discover;
2. All Matches;
3. Players;
4. Player Follow;
5. Match Detail.

Further required screens:

- Tournament Hub;
- Schedule;
- Draw/Bracket;
- Standings;
- Results;
- Following feed;
- Search;
- Login/account;
- Notification settings.

### 25.6 Motion

Use motion to communicate state:

- live pulse;
- score changed;
- followed;
- interesting toggled;
- schedule changed;
- screen transitions.

Respect reduced-motion system settings.

Do not animate merely for decoration.

---

## 26. Accessibility

Minimum requirements:

- touch targets roughly 44pt minimum;
- high score contrast;
- do not encode team identity with color only;
- status text alongside color;
- scalable text;
- VoiceOver/TalkBack labels;
- meaningful button labels;
- score updates announced carefully to avoid accessibility spam;
- landscape/tablet support where referee/operator views benefit;
- support device safe areas;
- avoid tiny court/status text.

---

## 27. Performance budgets

Audience app should feel instant on mobile data.

Targets to aim for:

- fast first meaningful tournament content;
- no giant uncompressed tournament images;
- sponsor images cached;
- video lazy-loaded;
- lists virtualized;
- no unnecessary full-tournament payload on app launch.

Scoring screen:

- score tap updates locally immediately;
- network latency must not block UI;
- offline mode should require no remote resource after match is loaded except eventual sync.

---

## 28. Public scale strategy

Expected V1:

- ~1,000 concurrent spectators;
- up to 20 active courts.

Avoid every client continuously hitting heavy raw Supabase queries.

Recommended:

- purpose-built public endpoints;
- short cache windows where acceptable;
- compact live payloads;
- pagination for players/matches;
- efficient polling or realtime depending on endpoint;
- server-side aggregation.

Live score data should prioritize correctness over excessive refresh frequency.

---

## 29. Realtime strategy

Current public web uses polling fallback.

For native:

Possible approach:

- active match detail: frequent compact update/realtime;
- match lists: moderate refresh;
- completed/static content: cache longer.

Do not expose broad Supabase realtime permissions until RLS/security is explicitly designed for it.

Server-mediated live endpoints are acceptable for V1.

---

## 30. Analytics

Recommended product analytics:

**PostHog**

Recommended operational error monitoring:

**Sentry**

### 30.1 Analytics events

Audience:

- app_opened;
- tournament_opened;
- match_opened;
- match_marked_interesting;
- match_unmarked_interesting;
- player_opened;
- player_followed;
- player_unfollowed;
- following_feed_opened;
- notification_opened;
- sponsor_impression;
- sponsor_click.

Player:

- player_claim_started;
- player_claim_succeeded;
- my_matches_opened.

Referee:

- referee_match_opened;
- scoring_offline_entered;
- scoring_offline_recovered;
- score_sync_error;
- score_sync_conflict.

Admin/operator:

- admin_action;
- screen_mode_changed where useful.

### 30.2 Never send

Do not send to analytics:

- access codes;
- player claim codes;
- auth tokens;
- phone numbers;
- email if unnecessary;
- private notes;
- score API secrets.

### 30.3 Sentry context

Critical scoring errors should include safe identifiers:

- app version;
- platform;
- tournament ID;
- match ID;
- device installation ID;
- online/offline state;
- pending queue count;
- API endpoint;
- error class.

Do not attach private credentials.

---

## 31. Notifications implementation

Recommended provider abstraction:

- Expo Notifications for app integration;
- APNs/FCM underneath;
- server-side delivery worker/service.

### 31.1 Event generation

Business events should generate notification candidates.

Examples:

`match_scheduled`  
`match_rescheduled`  
`court_changed`  
`match_starting`  
`match_live`  
`match_completed`  
`stage_completed`  
`tournament_started`  
`tournament_winner`

### 31.2 Recipient resolution

For each event resolve:

- followed players;
- interested matches;
- own player account;
- global tournament subscribers if event is major.

### 31.3 Dedupe

Generate deterministic dedupe key.

Example:

`match_completed:<match_id>:<user_or_device_id>`

### 31.4 Quiet/noise control

Do not notify for every score point.

Score point notifications are explicitly out of scope.

---

## 32. Privacy policy, terms, support

Required launch assets:

- Privacy Policy;
- Terms of Use;
- Support page/contact.

Privacy policy should cover at minimum:

- account data;
- player profile association;
- push tokens;
- follow/interest preferences;
- analytics;
- device/application diagnostics;
- public tournament data;
- sponsor metrics;
- retention/contact for deletion request.

If users can create accounts, provide account deletion path according to applicable store requirements.

---

## 33. Environments

Maintain:

- local;
- staging/preview;
- production.

Never point development builds at production by default.

Mobile config should clearly identify environment.

Example:

- `EXPO_PUBLIC_API_BASE_URL`;
- environment label;
- Sentry DSN per environment;
- PostHog key per environment.

Do not place server secrets in `EXPO_PUBLIC_*`.

---

## 34. Feature flags

Recommended flags:

- player_following;
- match_interests;
- personalized_notifications;
- ads_manager_video;
- mobile_admin;
- mobile_operator;
- player_checkin;
- realtime_live_scores.

Flags allow disabling a risky feature without rebuilding the entire tournament backend.

---

## 35. Testing strategy

### 35.1 Existing tests to preserve

Do not regress:

- scoring engine tests;
- tennis tests;
- tie tests;
- sponsor tests;
- screen tests;
- scoring lease tests;
- tennis-week E2E;
- tennis-TV E2E;
- replay tests.

### 35.2 New unit tests

Add for:

- follow resolution;
- interest merge;
- notification dedupe;
- player-code validation;
- player-code single use;
- featured tournament resolution;
- sponsor campaign scheduling;
- campaign link validation;
- offline queue ordering;
- native score recovery.

### 35.3 Integration tests

Required:

- player follows player → schedule event → one push recipient;
- user follows both players → only one notification;
- user follows player + marks match interesting → one notification;
- court changed → player follower receives update;
- offline score queue syncs in order;
- duplicate score retry remains idempotent;
- device lock prevents second scorer;
- admin releases lock → second device continues;
- sponsor hidden → disappears across intended surfaces;
- featured tournament change → web and app reflect same value.

### 35.4 Device matrix

At minimum test:

- recent iPhone;
- older supported iPhone;
- common Android flagship;
- common mid-range Android;
- iPad/tablet;
- weak/slow mobile data;
- offline/airplane mode.

### 35.5 Network scenarios

Test:

- full offline;
- high latency;
- packet loss;
- network switching Wi-Fi → SIM;
- SIM → Wi-Fi;
- app background/foreground;
- app kill;
- device sleep;
- stale auth;
- server 500;
- timeout;
- duplicate POST;
- retry after acknowledgement loss.

---

## 36. Real tournament QA dataset

Use a clone of a real tournament structure.

Recommended test setup:

- one Davis-style team event;
- 16 nations;
- multiple courts;
- realistic tie schedule;
- singles and doubles;
- actual stage progression.

Do not test only with tiny artificial two-team data.

---

## 37. Load testing

Before event:

Test at least:

- 1,000 public clients reading;
- 20 live matches/courts;
- sponsor assets;
- player directory;
- live match refresh.

Measure:

- API latency;
- database load;
- cache hit rate;
- error rate;
- public update delay.

Scoring writes are low volume relative to audience reads, but scoring integrity is highest priority.

---

## 38. Security testing

Before production:

- verify auth-code brute force rate limits;
- player claim-code rate limit;
- no direct database-write key in native bundle;
- verify public endpoints exclude private data;
- inspect network logs;
- test role escalation;
- test tournament ID tampering;
- test match ID tampering;
- test expired/revoked access;
- validate external sponsor URLs;
- restrict file upload type/size;
- verify video/embed sanitization.

---

## 39. Store strategy

### 39.1 Apple

Existing developer account available.

Prepare:

- bundle identifier;
- app record;
- app icon;
- screenshots;
- privacy data;
- privacy policy URL;
- support URL;
- reviewer instructions;
- reviewer access method;
- TestFlight;
- production submission.

If event deadline demands it, request expedited review with clear event context.

### 39.2 Google Play

No account currently.

Create an **Organization** Play Console account.

Complete:

- organization verification;
- D-U-N-S/business verification if required;
- package ID;
- store listing;
- app access instructions;
- Data Safety;
- privacy policy;
- internal testing;
- production submission.

Avoid creating the project under a new Personal developer account if that would introduce testing eligibility delays incompatible with event timing.

### 39.3 Fallback

Keep mobile public web working.

QRs at venue can point to public web if store install is unavailable.

Native success must not become a single point of failure for spectator access.

---

## 40. Five-day review-ready sprint

### Day 1 — foundation/security/contracts

- security audit;
- API contract map;
- mobile scaffold;
- environment config;
- shared types/scoring extraction plan;
- Figma foundations;
- audience core design;
- featured tournament backend model;
- public discover endpoint.

### Day 2 — spectator core

- Discover;
- tournament hub;
- all matches;
- live match;
- schedule;
- player directory;
- local Interesting matches;
- tournament skins.

### Day 3 — personalization + referee

- account/auth;
- player follow;
- player claim;
- Following feed;
- push registration;
- referee access code;
- match picker;
- native scoring UI;
- SQLite event queue.

### Day 4 — operations/commercial

- admin operational screens;
- TV operator entry/control;
- Ads Manager core;
- sponsor preview;
- announcements;
- PostHog;
- Sentry;
- iPad/tablet refinements.

### Day 5 — release candidate

- unit/integration regression;
- offline drills;
- score device handover;
- native builds;
- TestFlight;
- Play internal track;
- store metadata;
- privacy/terms/support;
- submission package.

---

## 41. October hardening plan

Use remaining time before 1 November for reliability.

### Week 1

- stabilize public APIs;
- stabilize scoring queue;
- fix critical UX;
- verify Figma-to-code consistency.

### Week 2

- real tournament clone;
- player follows;
- notification tests;
- sponsor campaigns;
- admin/operator.

### Week 3

- load testing;
- device matrix;
- store review fixes;
- venue-specific operational review.

### Final week

- feature freeze;
- only P0/P1 fixes;
- production rehearsal;
- backup devices;
- final store versions;
- production monitoring dashboards;
- staff training.

---

## 42. Event-day runbook

### 42.1 Before gates open

Verify:

- production API healthy;
- Supabase healthy;
- Sentry quiet;
- no pending migration;
- sponsor assets load;
- featured tournament correct;
- tournament public access on;
- all courts present;
- match schedule correct;
- TV screens correct;
- referee access code works;
- operator access works;
- push delivery test;
- QR/public links working.

### 42.2 Referee briefing

Every referee must know:

- select correct match;
- verify players/court;
- what Online/Offline/Pending means;
- continue scoring offline;
- never open same live match on second phone unless released;
- how to undo;
- how to pause;
- when to use retirement/walkover/DQ;
- who to contact for device replacement.

### 42.3 Control room

Monitor:

- live score delays;
- pending sync devices;
- TV screen status;
- incorrect court assignments;
- sponsor display;
- public API errors;
- notification delivery.

### 42.4 Incident severity

#### P0

Examples:

- score corruption;
- multiple authoritative scoring devices;
- database write security exposure;
- system-wide outage.

Action:

- freeze affected feature;
- switch to safe fallback;
- preserve evidence/logs;
- recover authoritative state.

#### P1

Examples:

- one match cannot sync;
- referee app crash loop;
- wrong TV score;
- critical notification/court update failure.

#### P2

Examples:

- cosmetic issue;
- sponsor animation issue;
- minor alignment.

Do not deploy P2 fixes during active critical play unless risk is negligible.

---

## 43. Rollback strategy

For web/backend:

- preserve previous deploy;
- use reversible migrations where possible;
- avoid destructive schema changes immediately before event.

For mobile:

- backend feature flags;
- server-side disable risky features;
- public web fallback.

Native binary cannot be instantly rolled back on every user device, so design server contracts defensively.

---

## 44. Observability dashboard

Event operations dashboard should expose:

- API error rate;
- scoring sync failures;
- conflict count;
- pending score queues reported;
- active live matches;
- push errors;
- sponsor media failures;
- application version distribution;
- public traffic.

Create alerts for:

- surge in score event failures;
- 5xx spike;
- database latency;
- push service outage;
- storage/media errors.

---

## 45. Backup/failure scenarios

### Internet failure at venue

Referees continue offline.

Public spectators may see stale scores until connectivity restores.

### One referee phone dies

Release control and move to replacement device.

### TV internet fails

Use last loaded state/holding fallback where possible and restore link.

### Push outage

Core app remains usable; push is convenience, not source of truth.

### Sponsor video fails

Fall back to poster/static logo.

### Store app unavailable

Use public web/PWA QR.

---

## 46. Acceptance criteria — audience

V1 audience is accepted when:

- app opens without mandatory login;
- featured tournament is visible;
- all tournaments remain accessible;
- all public matches are accessible;
- match filters work;
- Interesting can be toggled;
- guest interests persist locally;
- all players are discoverable;
- players can be followed;
- followed player next match is visible;
- live scores show correct state;
- match detail is clear;
- tournament schedule/draw/results work;
- sponsor placements load;
- major announcements can be received.

---

## 47. Acceptance criteria — player

- account can be created;
- valid player code links correct profile;
- invalid/used code fails safely;
- admin can assign profile;
- My Matches shows next match first;
- court/time changes appear;
- ranking/statistics/history available when data exists;
- own-match notifications work;
- no private player data leaks publicly.

---

## 48. Acceptance criteria — referee

- access code works;
- match list works;
- scoring engine behaves same as web rules;
- score tap is immediate;
- offline event persists;
- app can be killed/reopened without losing queued event;
- reconnect sync is ordered;
- duplicate retry is idempotent;
- second scoring device is blocked;
- undo works;
- result-confirmation setting works;
- final result reaches public/TV correctly.

---

## 49. Acceptance criteria — admin/operator

Admin:

- teams visible;
- key edits work;
- matches/courts/times manageable;
- settings editable;
- draw edits admin-only;
- announcements possible;
- sponsors manageable.

Operator:

- screens visible;
- modes controllable;
- court coverage/pin works;
- sponsor/holding/break controls work.

---

## 50. Acceptance criteria — sponsor

- main sponsor works;
- footer sponsors work;
- hide/show works;
- live preview matches real display;
- image creative works;
- video creative works;
- campaign date window works;
- optional link works;
- metrics record without affecting scoring performance.

---

## 51. Phase 2

Planned after stable launch:

- full tournament creation from mobile;
- event-scoped access codes;
- named staff accounts;
- granular role grants;
- richer push preferences;
- sponsor promotional push;
- advanced campaign analytics;
- full player check-in workflows;
- deeper tournament following;
- cross-event player following;
- additional sport rulesets;
- richer admin parity;
- more sophisticated public search.

---

## 52. Phase 3 / longer-term

Potential:

- wallet passes;
- ticket integration where relevant;
- club/academy integrations;
- athlete career profiles;
- season-wide following;
- livestream integration;
- broadcaster overlays;
- federation feeds;
- richer sponsor CRM exports;
- multilingual app;
- venue maps;
- advanced event content/news;
- social sharing cards.

These are not launch scope.

---

## 53. Locked current decisions

- product called Move Score;
- native folder: `move-score-app`;
- English only V1;
- audience opens directly into tournament discovery;
- no mandatory audience login;
- featured tournament controlled in admin and affects web + app;
- all matches publicly discoverable;
- users can mark matches Interesting;
- all players publicly discoverable;
- users can follow players;
- followed-player match notifications are required;
- player code claim + admin assignment;
- juniors have their own accounts for now;
- My Matches prioritizes upcoming match, ranking, statistics;
- player check-in not used for Davis/BJK scoring event;
- court/time changes notify player;
- team tie + individual rubber views supported;
- multi-sport architecture;
- referee access code;
- current referee can see all matches;
- future event-scoped role codes;
- offline scoring mandatory;
- referee can correct mis-click;
- final result confirmation is tournament setting;
- operator is TV operator, not referee;
- full audit required;
- mobile admin V1 is operations-first;
- full tournament creation later;
- draw edits admin only;
- sponsor footer preview;
- sponsor hide/show;
- image/video creative;
- upload/embed support;
- optional links;
- scheduling;
- tournament targeting;
- sponsor metrics;
- sponsor push Phase 2;
- Apple developer account exists;
- Google Play account must be created;
- publisher/store company handling remains owner responsibility;
- privacy policy/terms/support must be created;
- hard public target 1 November;
- ~1,000 concurrent spectators;
- up to 20 courts;
- primarily SIM/mobile network;
- personal iOS and Android phones;
- tablet/iPad layouts supported;
- push infrastructure may be created;
- PostHog + Sentry recommended;
- staging + production exist;
- use realistic tournament clone for QA;
- new Figma file created;
- Luma is inspiration for polish/hierarchy, not a template;
- reliability remains top priority.

---

## 54. Pending inputs

Still required from product/event owner:

1. final Move Score logo;
2. approved Davis Cup / Billie Jean King Cup artwork package for app use;
3. final official competition rules/regulations;
4. Apple bundle ID;
5. Android package ID;
6. Google Play Organization account;
7. privacy/support domain/public URLs;
8. final account-auth method if not chosen during implementation;
9. final tournament data for production;
10. sponsor creative files/campaign rules.

None of these should block core architecture work except final branding, store publication, and official scoring-rule confirmation.

---

## 55. Definition of done for the first public event

The project is considered event-ready only when:

- security launch gate passes;
- scoring offline/online recovery passes;
- production tournament data is verified;
- audience can see all matches;
- audience can browse/follow players;
- interests/follows behave correctly;
- notification dedupe passes;
- referee personal devices pass network tests;
- TV/operator flows pass;
- sponsor surfaces pass;
- public web fallback passes;
- TestFlight/Android production candidate is stable;
- production monitoring is enabled;
- event staff complete rehearsal;
- no unresolved P0/P1 issue remains.

---

## 56. Final architecture summary

```text
                            MOVE SCORE
                                │
            ┌───────────────────┼────────────────────┐
            │                   │                    │
         WEB ADMIN          PUBLIC WEB          NATIVE APP
         Next.js            fallback            Expo / RN
            │                   │                    │
            └───────────────────┼────────────────────┘
                                │
                         SERVER API LAYER
                                │
                    AUTH / PERMISSIONS / AUDIT
                                │
      ┌─────────────────────────┼──────────────────────────┐
      │                         │                          │
  TOURNAMENT                SCORING                    ENGAGEMENT
  teams                     score events               follows
  players                   snapshots                  interests
  ties/rubbers              leases                     notifications
  courts                    offline sync               announcements
  draws                     audit                      sponsors
      │                         │                          │
      └─────────────────────────┼──────────────────────────┘
                                │
                           SUPABASE
                 PostgreSQL + Storage + secure server access
```

The essential rule is simple:

**one tournament truth, multiple carefully permissioned experiences.**

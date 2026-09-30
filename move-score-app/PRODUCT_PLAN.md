# Move Score Mobile — Product & Delivery Plan

Status: product scope locked for Phase 1
Target: review-ready build in 4–5 days; public event deadline 1 November 2026
Repository branch: `move-score-mobile`

## 1. Product principle

Move Score is a multi-sport live tournament platform. The existing Next.js/Supabase web platform remains the system of record. Mobile extends the same tournament, scoring, sponsor and operator data rather than creating a second backend.

Phase 1 prioritizes:
1. Reliability and offline scoring
2. Public tournament discovery and live scores
3. Player My Matches
4. Referee operations
5. Sponsor exposure / Ads Manager
6. Mobile admin operations

Full tournament creation on mobile is Phase 2.

## 2. Mobile roles

### Public audience — no login required
- Landing screen opens directly to tournament discovery.
- One admin-selected featured tournament is visually dominant.
- Live featured tournament is prioritized first.
- Upcoming tournaments follow.
- Past tournaments follow.
- Non-featured tournaments can be collapsed under an All tournaments control when a featured tournament is active.
- Tournament pages: overview, live, schedule, draw/bracket, standings/rankings, results, teams/players, venue/info, news/announcements, streaming links where applicable, sponsors.
- Local favourites are allowed without login.
- Login is required only for cross-device account state and player functionality.

### Player
- Account can claim an existing player profile using a one-time player code.
- Admin can assign/link an account to a player profile.
- My Matches order:
  1. Next/upcoming match
  2. Ranking
  3. Statistics
  4. Match history / results
  5. Draw / tournament context
- Court/time changes trigger player notifications.
- Player check-in is supported by the product but disabled per tournament; it is not used for the Cairo Davis/BJK event.

### Referee
- Access-code login.
- Can see all tournaments/matches in Phase 1.
- Future architecture supports event-specific role codes.
- Offline-first scoring is mandatory.
- Referee can undo/correct mis-clicks directly.
- Result-confirmation behavior is controlled by tournament settings.
- Full audit trail is mandatory.

### Admin
Phase 1 mobile admin:
- View tournaments
- Teams / nations
- Edit selected team details
- Tournament settings edits
- Generate/manage matches where supported
- Schedule/court adjustments
- Referee/scoring oversight
- Draw edits restricted to admin
- Announcements
- Sponsor controls

Phase 2:
- Full create-tournament wizard and all web parity.

### TV operator
- Separate operator role.
- Controls TV/display state and scenes.
- Does not score matches.

## 3. Tournament home highlighting

Add a single global featured tournament selection controlled from the web admin.

Behavior:
- Featured tournament drives the hero treatment on web and app.
- If it is live/active, it is the first content shown.
- Remaining tournaments become secondary and may sit inside a collapsed All tournaments section.
- Upcoming and past remain discoverable.
- Clearing the featured tournament restores normal chronological discovery.

Recommended data model:
- global/platform setting: `featured_tournament_id`
- avoid duplicating a boolean across tournaments
- every client reads the same source of truth

## 4. Architecture

### Existing system retained
- Next.js 16 / React 19
- Supabase Postgres + Storage
- server-side data access
- event-sourced scoring
- `score_events`
- `match_score_snapshots`
- `audit_logs`
- scoring-control leases/device locks
- tennis team ties/rubbers
- TV screens/operator controls
- sponsor/footer system

### New native app
Recommended:
- React Native
- Expo
- TypeScript
- Expo Router
- TanStack Query for server state
- Zustand or equivalent only for small local UI/session state
- Expo SQLite for durable offline event queue
- SecureStore for credentials/tokens
- Expo Notifications for APNs/FCM abstraction
- EAS Build / Submit

### Shared code
Extract framework-free domain logic into reusable package(s), especially:
- scoring engine
- scoring rules
- tennis tie rules
- stage rule resolution
- score event types
- sponsor helpers where portable
- shared TypeScript API contracts

Do not import Next.js/server modules into mobile.

## 5. Offline scoring

Native scoring must preserve the current web protocol:

1. Referee opens/claims a match.
2. Device receives current authoritative snapshot + sequence.
3. Score taps apply locally immediately.
4. Every action is persisted to local SQLite before considered accepted on-device.
5. Ordered events sync to the server.
6. Server validates:
   - match/device control
   - sequence
   - idempotency
   - valid score transition
7. Server writes score event + snapshot + audit data.
8. Public/web/TV/mobile clients receive refreshed state.
9. Reconnect flushes pending events in order.
10. Conflicts stop automatic mutation and enter a clear recovery state.

Required states:
- Online
- Offline
- Syncing
- Pending sync
- Conflict
- Sync error

Never silently discard a score event.

## 6. Tennis support

The repository already supports:
- padel
- tennis
- chess
- tennis nation/team ties
- singles and doubles rubbers
- per-stage scoring
- result confirmation setting
- offline scoring
- TV scene logic

For Davis/BJK:
- support team tie as parent object
- support individual singles/doubles rubbers beneath the tie
- keep both UI representations until official event rules are finalized
- final competition regulations override assumptions in current demo logic

Future sports plug in through additional rulesets rather than a new app.

## 7. Player identity

Use persistent player profiles.

Phase 1 recommendation:
- player creates an app account
- one-time player code claims a profile
- player code is stored hashed, not plaintext
- code expires or is invalidated after successful claim
- admin can manually assign/link an account
- tournament player rows continue linking to persistent `player_profile_id`

Existing forward-compatibility fields such as player profile auth linkage should be reused where possible.

## 8. Favourites

Guest favourites do NOT require login.

Guest:
- saved locally on device
- tournament/team/player/match favourites supported
- persist across app restarts
- not guaranteed after uninstall/device change

Logged-in:
- sync favourites to backend
- portable across devices

Phase 1 notifications are not personalized favourites notifications; they are major tournament announcements.

## 9. Notifications

Phase 1 sends high-value tournament announcements only:
- event started
- group stage ended
- quarter-finals announcement
- semi-finals announcement
- final announcement
- major match starting
- country/team wins
- manual major announcement

Avoid sponsor push advertising in Phase 1.

Support anonymous device subscriptions so public users do not need an account merely to receive event announcements.

## 10. Sponsor / Ads Manager

The existing branding system already supports main sponsor and footer sponsors.

New requirements:
- tournament-scoped campaigns
- static image creatives
- video creatives
- uploaded or embedded creative source
- optional outbound URL
- start/end scheduling
- active/inactive
- per-sponsor show/hide
- live footer preview
- web/TV/public/mobile placement control
- impression and click analytics
- sponsor links globally or per campaign can be enabled/disabled

Recommended normalized model:
- `sponsor_campaigns`
- `sponsor_creatives`
- `sponsor_placements`
- aggregated `sponsor_metrics` or append-only interaction events with rollups

Do not use personalized programmatic ads in Phase 1. This is a tournament sponsorship system.

## 11. Visual system

Direction: editorial event discovery + premium sports broadcast.

Reference qualities from Luma:
- calm hierarchy
- strong event imagery
- generous spacing
- low visual noise
- polished sheets/transitions
- event content takes priority over chrome

Move Score differentiation:
- competition-led typography
- prominent live state
- scoreboard-grade numerical hierarchy
- tournament skins
- dark live-match mode
- structured sponsor exposure
- broadcast motion, not generic gradient/glass UI

Recommended typography:
- Manrope for UI/editorial text
- a condensed sports/data face for score numerals and compact labels
- exact second font to be locked during Figma foundations

Avoid generic AI-dashboard patterns.

## 12. Tournament skins

Core Move Score UI stays stable.
Per tournament:
- event logo
- competition colors
- background/artwork
- imagery
- sponsor system
- optional light/dark treatment

Davis/BJK assets must use approved competition artwork/brand rules.

## 13. Figma structure

File: Move Score Mobile

Pages:
- 00 Product Brief
- 01 Foundations
- 02 Audience
- 03 Player
- 04 Referee
- 05 Admin & Operator
- 06 Ads Manager

First design pass should establish:
- Launch / landing
- Tournament discovery
- Tournament hub
- Live match
- Schedule
- Draw / standings
- My Matches
- Referee score console
- Admin event control
- Ads Manager

## 14. Analytics & monitoring

Recommended:
- PostHog: product analytics on web + mobile
- Sentry: production errors/crashes/performance
- server logs retained for score sync and critical mutations

Key analytics:
- app launch
- tournament opened
- match opened
- favourite added
- player profile claimed
- push opened
- live-score watch duration
- sponsor impression
- sponsor click
- scoring offline entered/recovered
- sync conflict/error

Never send raw access codes, player private contact details, or score-event secrets into analytics.

## 15. Security launch gate

The repo currently documents a critical Supabase hardening task: the anonymous key must not retain broad database access.

Before native release:
- use server secret/service credentials only on trusted server
- remove broad anon/authenticated full-access policies
- define explicit public read APIs
- define authenticated write APIs
- keep score writes server-authoritative
- rate-limit public/player-code endpoints
- hash access/player codes
- add role/tournament authorization to every mutation
- audit sensitive mutations

Mobile must never ship a credential that can directly rewrite tournament tables.

## 16. Store/release plan

### Apple
- existing organization developer account
- EAS iOS build
- TestFlight
- privacy policy
- support URL
- reviewer credentials/access-code instructions
- App Store submission
- expedited review can be requested if event timing requires it

### Google
- create ORGANIZATION Play Console account
- complete D-U-N-S/business verification
- do not open a new personal account for this project
- internal testing first
- production submission once account setup permits

### Fallback
Maintain mobile web/PWA/public tournament URLs as an event-day fallback even after native apps ship.

## 17. 5-day review-ready sprint

### Day 1
- security/backend contract audit
- mobile workspace scaffold
- shared API types
- Figma foundations + audience direction
- featured tournament backend setting

### Day 2
- audience landing/tournament hub/live/schedule
- tournament skin system
- public API layer
- local guest favourites

### Day 3
- referee login + match picker
- native scoring console
- SQLite offline queue
- player auth/profile claim + My Matches

### Day 4
- admin operational screens
- sponsor Ads Manager core
- push announcements
- PostHog/Sentry
- iPad/tablet adaptation

### Day 5
- regression/E2E
- network failure testing
- store assets/metadata
- TestFlight + Play internal build
- review submission package

## 18. Hardening window to 1 November

Use the remaining October window for:
- real tournament clone QA
- 20 simultaneous court simulations
- 1,000-viewer load testing
- SIM/network loss drills
- referee device handover
- score correction/undo tests
- app-kill/relaunch tests
- push tests
- sponsor video/image failure tests
- iOS/Android/tablet device matrix
- live venue rehearsal

## 19. Explicit Phase 2

- full tournament creation from mobile
- event-specific role/access-code grants
- sponsor promotional push campaigns
- advanced sponsor analytics
- more sports/rulesets
- richer player check-in workflows
- deeper personalization and cross-device favourites

## 20. Current blockers / inputs still needed

- final Move Score logo
- approved Davis/BJK artwork package for mobile use
- official final competition scoring/format regulations
- Google Play Organization account + D-U-N-S verification
- bundle/package identifiers
- public privacy/support/terms domain or page locations

These do not block the architecture work except store publication and final visual branding.

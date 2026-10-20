# National team coaches

Owner decisions for the Junior Finals (Davis Cup Juniors, Billie Jean King Cup Juniors). Migration `0037_coach_access.sql`.

## In one paragraph

One access code per team (a nation in one event: Egypt boys and Egypt girls have separate codes). The head coach and
every assistant sign in with that same code, each on their own device, in the Move Score app (Account → Staff → Coach
sign-in, or the card's QR `https://tour.mbeg.org/c#<code>`) or on the web (`/coach`). A coach sees only their own team,
read only, and gets their team's alerts. A coach is never staff: coach tokens (`mbc1.`) are refused by every staff
route, and coach routes accept nothing else.

## Organiser (Admin → Team coaches, `/admin/org/coaches`, admins only)

- **Codes are made by themselves when the draw is confirmed** (owner, 20 Oct 2026): generating an event's group ties
  (Ties → "Generate the group ties", or the Groups page regenerating the group stage) gives every team of that event a
  working code (`src/lib/coaches/autoCodes.ts`, `ensureCoachCodes`; pure rule `teamsNeedingCodes` in `rules.ts`).
  Idempotent: a team with a working code gets none (and `coach_codes_one_live_idx` refuses a second even in a race); a
  team added later gets one the next time the ties are generated or with the button below. The Ties page then says
  "Coach codes created for N teams — print the cards" with links to the cards and Team coaches. Audit `via: "draw"`.

- Pick the event (both events of an event group are on one page). **Create a code for every team**: one code per team
  without a working one. Codes are random event codes (`src/lib/orgs/codes.ts`), stored as HMAC-SHA256 under
  `EVENT_CODE_PEPPER` plus a sealed copy for reprinting; they work until the end of the team's own event (23:59 Cairo).
- Per team: **Share** (a branded PNG of the card, 1080×1350, `/qr/coaches/share?event=…&team=…`, to send on WhatsApp),
  **Card** (printable, `/qr/coaches?event=…&team=…`; **Print all cards** two to an A4 page), **New code**
  (the old one stops at once, its devices are signed out), **Revoke**. The list shows how many devices are signed in.
- Audit: `COACH_CODE_CREATED`, `COACH_CODE_REVOKED`, `COACH_LOGIN` (never the code).

## What a coach sees (`src/lib/coaches/rules.ts`, `server.ts`)

Their group table; every tie of their team with court and time; their own line-up once entered by the court referee,
master referee or organiser; the opponents' players of a rubber as soon as the tie's line-ups are confirmed (locked by the court referee, a master
referee or the organiser: line-ups are public once published, owner's decision 20 Oct 2026) or the rubber is under way; live scores
(our team first) and the match log of their own rubbers, without referee names; their players' schedule; after the
groups, Cup or Plate and the next ties; the final place. Another team's tie, rubber, line-up or log answers 404 exactly
like a missing one. Coaches cannot score or call the master referee, and cannot change line-ups unless the event's
coach line-up entry is switched on (below; off by default).

API (all `private, no-store`): `POST|DELETE /api/mobile/v1/coach/session`, `GET coach/team`, `coach/ties/{id}`,
`GET|POST coach/ties/{id}/lineup` (POST only with coach line-up entry on, else 409 `feature_off`), `coach/matches/{id}`,
`coach/matches/{id}/log`.

Sign-in brakes: failed attempts only (a right code is refunded), atomic `takeRateLimit`: 20 per address and 40 per code
prefix per 15 minutes (`coach-login:*`, `coach-code:*`).

## Coach line-up entry (off until officially confirmed)

Owner, 20 Oct 2026: coaches may submit their own team's line-up, but the feature stays **off** ("on the shelf") until
it is officially confirmed. While off, everything is exactly as above: coaches are read only, no "Enter line-up" in the
app or on the web, `POST coach/ties/{id}/lineup` answers **409 `feature_off`**, and the officials' pickers say nothing
about coaches.

- **The switch** (admins only): Admin → Team coaches → the event → per event "Coaches enter their own team's line-up",
  with an optional "Closes N min before the tie" (empty: open until the line-ups are confirmed). Stored in
  `tournaments.format_config.ties.coachLineups` (`{ on, deadlineMinutes }`, no migration); not a scoring feature or a
  match-day rule, so no default (`SCORING_FEATURES_ON`, `DEFAULT_MATCH_DAY_RULES`) ever turns it on. Audit
  `COACH_LINEUPS_SWITCHED`. Pure rules `src/lib/coaches/lineupEntry.ts` (via `@core`), server `src/lib/coaches/lineups.ts`.
- **What a coach does** (switch on): on their own tie (app `coach/tie/[id]` → "Enter line-up"; web `/coach/ties/[id]`)
  they pick their two singles players from their squad (order of merit, No. 1 first) and, if they wish, the doubles pair
  ("to be named" until after the singles, Reg 43). Same checks as the officials (`lineupRules.ts`): problems refuse
  (400), warnings (Reg 43 order of merit, Reg 50 retired player) are submitted only once the coach ticks "I accept",
  with the regulation link shown (409 `warnings` until then). They can change it until the court referee, a master
  referee or the organiser confirms (locks) the line-ups, or until the deadline; after that 409 `locked` / `deadline` /
  `under_way` and the form is view only: changes go through the officials as before.
- **A submission is not the line-up.** It is kept as an audit row `COACH_LINEUP_SUBMITTED` (entity = the tie; side,
  team, line-up, accepted warnings; `actor_role` `coach`, `actor_name` "Coach of Egypt"), never written to the
  rubbers, so no public page, screen or the opponent's coach ever sees it; the opponent's coach sees only its own form.
- **Officials** (court referee, master referee, organiser) see it in their line-up picker (web and app; additive
  `coach` field of the picker answer): "Submitted by the coach at HH:MM" per side, prefilled while it is newer than what
  the officials last saved and not confirmed yet. Confirming it ("Confirm the singles") writes it through `setLineup`
  and locks the line-ups (the official accepts any warning again, as today). The court referee signed in on the tie's
  court and the master referees on duty get a push when a coach submits or changes a line-up.
- **An accepted exception** by a coach is audited `LINEUP_EXCEPTION_ACCEPTED` (actor `coach`, `actor_name` "Coach of
  Egypt"), pushed to the master referees on duty, shown on the master's and organiser's live banners, and emailed to
  the organisation's owners and admins (`staff_alert`; `MESSAGING_DRY_RUN=1` sends nothing).
- **Security**: coach token only (`coachRoute`); another team's tie answers 404 like a missing one; brakes per sign-in
  (20 / 10 min) and per team (40 / 10 min), atomic `takeRateLimit`; only the coach's own squad ids are accepted; explicit
  columns (`lineupEntry.test.ts` scans the routes and the server).
- **App and old app**: additive only — `MCoachTie.lineupEntry` (`{ open, submittedAt }`, present only while on) and the
  line-up answer's `entry` (`MCoachLineupEntry`). Move Score 1.0.1 has no coach screens.

## Branding of printed and exported files

Every file a user prints or downloads carries the same branding (`src/lib/brand/`): a navy band with the Move Score
lockup and the Move Beyond logo (`public/brand/move-beyond-logo-{white,black}.png`, trimmed from the owner's
`Profile/MB LOGO/primary logo*.png`), the event's and the organisation's logos (white chips), the event's name on its
colour (app skin seed A → organisation primary → Move Score blue), the footer line "Move Score by Move Beyond ·
tour.mbeg.org" and, on printed cards, the event's sponsors (small, at the foot).

- Print: `/qr/courts`, `/qr/coaches`, `/qr/match/[id]` (`components/brand/PrintBrand.tsx`).
- Excel (`brand/excel.ts`, `brandSheet`): the tournament workbook (`api/tournaments/[id]/export`) and the line-up
  template: three brand rows (logos, event, footer line) above a coloured header row frozen under them; printed
  header/footer with page numbers. The line-up reader finds the header row by its names, so uploads still read.
- Share images (`brand/shareCard.tsx`, next/og): `/qr/coaches/share`, `/qr/courts/share` (staff only, never cached).
  The server fetches logos only from our own storage or site (`fetchableLogo`); other URLs show on print pages only.
- CSV: the session export has a "Made with" line; the announcement deliveries CSV and the teams import template are
  machine formats and stay plain.

## Alerts

To every phone signed in with the team's working code (`coach_sessions.installation_id`, target `coach_team`): tie in
5 minutes, rubber next on court, called to court, started, finished (won/lost with the score), tie result, line-up
entered or changed (own players only). Sent through the normal outbox and drain; `PUSH_DRY_RUN=1` sends nothing.

## Links

`/c` is in the AASA and the Android intent filter (exactly `/c`). Move Score 1.0.1 has no coach screens: a card
scanned on a phone with 1.0.1 opens its "page not found"; nothing 1.0.1 already calls changed (`npm run e2e:old-app`).
Without the app, `/c` shows the download links and, on request, opens My team in the browser.

## Gates

Unit: `src/lib/coaches/coaches.test.ts`, `src/lib/coaches/lineupEntry.test.ts`. E2E: `npm run e2e:coaches` (stand-in;
server with `PUSH_DRY_RUN=1` and `MESSAGING_DRY_RUN=1`): coach line-up entry both off (refused, nothing visible) and on
(the full flow).

## Deploy

1. Owner applies `0037_coach_access.sql` on the live project before deploying.
2. Admin → Team coaches → create the codes, print the cards, hand one to each team.
3. Before the next app build: nothing extra (the `/c` app link ships with it). The AASA change reaches iPhones within a day.

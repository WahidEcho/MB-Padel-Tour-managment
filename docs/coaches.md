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
like a missing one. Coaches cannot score, change line-ups or call the master referee.

API (all `private, no-store`): `POST|DELETE /api/mobile/v1/coach/session`, `GET coach/team`, `coach/ties/{id}`,
`coach/ties/{id}/lineup`, `coach/matches/{id}`, `coach/matches/{id}/log`.

Sign-in brakes: failed attempts only (a right code is refunded), atomic `takeRateLimit`: 20 per address and 40 per code
prefix per 15 minutes (`coach-login:*`, `coach-code:*`).

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

Unit: `src/lib/coaches/coaches.test.ts`. E2E: `npm run e2e:coaches` (stand-in; server with `PUSH_DRY_RUN=1`).

## Deploy

1. Owner applies `0037_coach_access.sql` on the live project before deploying.
2. Admin → Team coaches → create the codes, print the cards, hand one to each team.
3. Before the next app build: nothing extra (the `/c` app link ships with it). The AASA change reaches iPhones within a day.

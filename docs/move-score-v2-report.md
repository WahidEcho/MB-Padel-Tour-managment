# Move Score plan v2 — migration report (13 Oct 2026)

What was built overnight from plan v2 (organisations, players, leagues, match day, registration), how it was
checked, and what the owner has to do before any of it goes live.

**Nothing has been pushed, deployed or applied to the live database.** All work is local commits on
`move-score-mobile` (27 commits after `0159033`; 384 files, +43k lines) and one local branch in the Move Tick
repo (`move-score-partner-api`). The only live change this session was the `rls_canary` table and the
secret-key switch the owner made.

> Do not push `move-score-mobile` until the deploy steps below are done. The new code reads tables and
> columns from migrations 0022–0030; deployed without them, staff sign-in and the app API fail.

## 1. What each phase delivered

| Phase | What it gives you |
|---|---|
| 0 Foundations | Sports registry; match-day rules per tournament/session (Admin → tournament → **Match day** tab); Admin → **Discover** page (hero order + app flags); migration 0022. |
| 0.5 Organisations | Clubs/academies apply, Move Beyond approves (Admin → Platform → Organisations) or creates them; invites by signed link (accept step after sign-in); members and roles; event codes for referees/operators (hashed, scoped, revocable at once); org profile + branding; org page in the app; follow an organisation. Every admin page, action and API resolves the organisation from the row itself. |
| 1 Player identity | One profile per person linked to the app account; player codes stored hashed (sealed copy for "Send code"); WhatsApp one-time code (email fallback only after the player agrees, only to their own confirmed email); organiser "link to app account" offers the player confirms; platform-only merges; **My profile** screen. |
| 2 Final-result entry | Admin / organiser / referee can enter a final score (two-step confirm, tie-break points required); the server rebuilds and checks every result; organisers can correct a finished match (audited, standings and draws updated); chess win/draw/loss. |
| 3 Match-day engine | "Match may start in ~5 min" alert once per match when a side is one game from winning; court call with countdown, −2 min reminder, no-show prompt (keep waiting / +5 min / walkover); "I'm at court"; QR check-in marks present. |
| 4 Live courts hero | Swipeable per-court showcase at the top of Discover on live days (walk-on, photos, live score, result, next on court), featured + every live tournament in your Discover order. |
| 5 App screens | Referee call card, no-show sheet and final-score entry in the app and web console; player "I'm at court". |
| 6 Lock screen & widgets | Live Activity countdown phases (soon → called → live → final), start by push, one card per match, **My matches** widget (home + lock screen). Your existing provisioning profiles already include the App Group and push — no portal change needed. Not yet run on a phone. |
| 7 Leagues | Nights or season leagues with divisions, editable points (default win 2 / loss 1, streak optional), monthly and 3/6/9/12-month boards, top of all leagues per organisation and platform-wide, join by open / approval / invite code / paid (pay at venue for now). |
| 8 Americano/Mexicano nights | "Confirm players and publish table": per-court order with "about 19:40" estimates that re-estimate as matches finish; on web, TV, app and league page; live nights appear in the hero. |
| 9 Registration & payment | Register in Move Score (team or individual), organiser approval, pay through **Move Tick** (partner API: hosted checkout, signed webhooks, refunds until 24 h before `starts_at`), pay-at-venue fallback, archive 24 h after the event. Online payment is Move Beyond only. |

Also: Next.js 16.2.9 → 16.3.8 (cleared critical advisories), the open redirect on `/login?next=` fixed, a
latent bug fixed where `/me/matches` returned nothing for linked players.

## 2. Security work

Every phase got an independent security review, its findings were fixed, and each fix got an attack test
that was shown to **fail on the code before the fix**:

| Review | Serious findings fixed (examples) |
|---|---|
| 0.5A | Another org's tennis ties editable via a public tie id; registration form used to pull other orgs' players and their contacts; global login lockout; rollback script would expose new private tables; shared admin password was platform admin. |
| 0.5B | Announcements revealed a matched player's email; matched player's photo on public pages; shared password could create lasting memberships; non-atomic rate limits; silent invite acceptance / invite-cookie lockout; owner-removal race (proved on real Postgres). |
| 1 | Email fallback could take over another player's history by phone number; rogue-org email linking; OTP brute force via parallel requests; plain codes in old message logs (scrub script). |
| 2–8 | League-night re-linking after a code reset; referee codes overwriting finished results; court-call spam; widget showing non-public matches; suspended orgs' nights visible. |
| 9 | Knocking another player out of a session by phone; double charge / unrefundable duplicate; same-name pairing; messages to unverified contacts; fake "full" events; payment holds renewed forever. |

Standing protections: every new table has RLS on with no anon access (test-enforced, and on the rollback
script's never-reopen list); codes, OTPs, invite and league tokens stored only as peppered hashes; private
player columns never selected into public, TV, referee or app responses (test-enforced); a cross-org
**attack script** (`npm run e2e:organizations`, 965 checks) tries every admin action and API with another
organisation's ids. A secrets scan of the public GitHub repo's full history found nothing.

## 3. Final test results (HEAD `4eaa310`)

lint, `tsc` (web + app) clean · vitest 1603 passed · app tests 22 passed · `npm run build` ok ·
stand-in E2E, all 0 failed: registration 100, organizations 965, mobile-api 224, final-score 64,
match-day 88, leagues 81, nights 54, tennis-week 42, lease-control 32, messaging 34, mobile-signin 60 ·
Move Tick partner tests 20 passed.

Not run: `e2e:tennis-tv` (needs Playwright, not installed on this Mac); anything on a real iPhone; anything
against the live database.

## 4. Owner checklist, in order

1. **Close the database gate** (blocked for me by the permission system): Supabase → SQL Editor → paste
   `supabase/gate/close_open_access.sql` → Run. Then check `https://tour.mbeg.org` and a TV screen still load.
2. **Vercel env vars (Production + Preview)** — generate each as a long random value:
   `STAFF_SESSION_SECRET`, `EVENT_CODE_PEPPER`, `PLAYER_CODE_PEPPER` (different from the event pepper),
   and confirm `PUBLIC_SITE_URL=https://tour.mbeg.org`. Later: `APNS_*` (Live Activities),
   `MOVE_TICK_*` (payments), `WA_OTP_TEMPLATE` (after Meta approves).
3. **Apply migrations 0022 → 0030** to the live project, in order (all additive). Apply 0023 off-peak
   (it briefly locks `tournaments`). Then run Supabase advisors (security + performance).
4. **Supabase Auth**: add `https://tour.mbeg.org/staff/auth/callback` to the redirect allow-list. Keep
   Resend click tracking off.
5. **Deploy** (push `move-score-mobile`; the last commit must touch the server).
6. **Owner SQL** from `docs/organizations.md` (makes you platform admin + Move Beyond owner), then sign in
   on the web with your own Google/email account — Discover, flags and org approvals need it (the shared
   admin password no longer reaches them).
7. **Player codes**: `scripts/ops/hash-player-codes.ts --dry-run`, then the real run (`--first-run` the
   first time); then `scripts/ops/scrub-delivery-codes.ts --apply`.
8. **WhatsApp**: submit the `mb_login_code` authentication template (definition in `docs/messaging.md`).
9. **Move Tick** (when ready for online payment): review branch `move-score-partner-api`, apply
   `20261069` + `20261070`, set its four `MOVE_SCORE_*` vars, schedule the partner-webhooks cron, rehearse
   with a test card (`docs/move-tick-partner-api.md`).
10. **Phone build** (Phase 6): plug in the iPhone, `cd move-score-app && npm install`, then follow
    `move-score-app/docs/device-install.md`. Nothing goes to App Store Connect.

**Timing advice:** this is a large change three weeks before the 2 Nov World Cup. Steps 1–4 are safe to do
now. I'd deploy (step 5) only after a rehearsal day where you sign in as staff, score a match with a referee
code, and check TVs — the shared role passwords still work for Move Beyond, so referees aren't cut off.

## 5. Decisions still waiting on you

- Americano points format (rally-to-N?) and the reference table layout — the night table is built so either
  is a small change (`src/lib/friendly/nightTable.ts`).
- ~~Registration defaults~~ — decided 14 Oct 2026 (DECISIONS.md § 8, migration 0030): first paid, first in by
  default (organiser approval still an option), entry type individual / team / both, refunds always 100 %.
- 9-month boards: block of 9 then the remaining 3, or rolling last 9 months (both built).
- League defaults chosen: walkover win 2 / loss 0, streak off, chess draw 1.5.

## 6. Not done / follow-ups

- Paid league memberships and per-night fees through Move Tick; partial refunds.
- Hand-reordering a night's table; an alert when an estimate moves a lot.
- Removing the shared role passwords entirely (planned once referees use event codes).
- App Store privacy answers need re-checking (the privacy page now mentions payments via Move Tick).
- `node-forge` (Wallet signing) still has an advisory with no fixed release; it isn't used for signature checks.
- Disk on this Mac is nearly full (~0.6 GB free); builds may fail until space is freed.

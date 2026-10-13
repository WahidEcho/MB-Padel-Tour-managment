# Organisations (Phase 0.5, parts A and B)

Clubs, academies and organisers each run their own tournaments, sessions, event groups, seasons,
ranking categories and announcements. Everything that existed before moved into one organisation,
**Move Beyond** (slug `move-beyond`). Migration: `supabase/migrations/0023_organizations.sql`.

## Who can sign in to the staff console

| Who | How | Token |
|---|---|---|
| Owners, admins, managers (and any member) | `/login` → Google, or email + password (a Move Score account) | our own signed `mbs1.` cookie `{user, org, role, exp}`, 24 h |
| Referees, TV operators | `/login` → event code, or the app's referee screen | `mbs1.` token `{code, org, role, scope, exp}`, 24 h on the web, 7 days in the app, never past the code's expiry |
| Move Beyond only, until retired | the shared role passwords (`ADMIN_PASSWORD` …) | the older `role.expiry.signature` token; **never a platform admin** |

The server checks the Supabase session itself once, at sign-in (`getAuthUser`), then issues its own
cookie and drops the Supabase session. On **every** request (`src/lib/auth/staff.ts`):

- a member's membership must still be `active` (or the person still a platform admin) and the
  organisation still `approved`; the role used is the one in the database now;
- an event code must not be revoked or expired; its role and tournament scope come from the code row;
- shared-password tokens only ever reach the Move Beyond organisation, and are never platform admins:
  Discover, feature flags and merging players need a real `platform_admins` person (below).

The web cookie is `__Host-mb_session` (Secure, host-only, path `/`, httpOnly, SameSite=Lax), so no
other subdomain can plant or overwrite it. Only a localhost development server (no HTTPS) uses the
plain `mb_session` instead. Deploying this signs everyone out of the web console once (the old
`mb_session` cookie is no longer read off localhost); the app's bearer tokens are unaffected.

Removing a member, suspending an organisation or revoking a code takes effect on the next request.
A revoked code answers `401 {"code":"code_revoked"}` with a clear message; the app keeps its queued
points until a new code is entered.

Staff tokens start with `mbs1.` (or are the legacy `role.expiry.signature`); user tokens are Supabase
JWTs. Each side refuses the other's format before verifying anything (`isStaffTokenShaped`).

## Setting up the owner (one-time SQL, run by the owner)

Platform admins are never seeded by a migration or an environment variable: a variable that grants
super-admin to whoever signs in with an email is one leaked or mistyped setting away from handing the
platform to someone else. The owner runs this once in the Supabase SQL editor **after signing in to
Move Score once** (so the auth user exists), with their own email:

```sql
with u as (select id, email from auth.users where lower(email) = lower('OWNER_EMAIL_HERE'))
, pa as (insert into platform_admins (auth_user_id, email, note) select id, email, 'owner' from u on conflict (auth_user_id) do nothing)
insert into organization_members (organization_id, auth_user_id, invited_email, role, status)
select o.id, u.id, u.email, 'owner', 'active' from organizations o, u where o.slug = 'move-beyond'
on conflict (organization_id, auth_user_id) where auth_user_id is not null do update set role = 'owner', status = 'active';
```

**After the deploy that ships this, the shared `ADMIN_PASSWORD` no longer opens the platform pages**
(Admin → Discover, feature flags, merging duplicate players). Run the SQL above first, then sign in at
`/login` with your own Google or email account to reach them.

Check: `select * from platform_admins;` and
`select role, status from organization_members m join organizations o on o.id = m.organization_id where o.slug = 'move-beyond';`

Other organisations and their staff arrive through applications and invites (below); no SQL needed.

## Onboarding (part B)

- **Apply:** `/organizations/apply` (public; the app's Account → "Run a club, academy or events?" opens it
  with `?via=app`). Stored as `organizations.status = 'applied'` with the form in `application` (only
  the whitelisted fields; anything that looks like a password or key is refused). Rate-limited per
  network address (5/hour) and per contact email (3/day, hashed key), 6,000 characters at most, a
  hidden honeypot field, and the same answer whatever happened (`src/lib/orgs/apply.ts`). An application
  holds **no public slug** (a random `applied-…` placeholder): its slug is made from its name (or typed by
  the platform admin) only when it is approved, so applications, turned-down ones included, never claim
  a name's address. A name that is Move Beyond's or another organisation's is refused.
- **Decide:** Admin → **Organisations** (`/admin/platform/organizations`, platform admins only):
  approve (invites the applicant, or another address, as owner) or turn down (`rejected`); suspend /
  reinstate (members and codes stop on their next request; Move Beyond itself cannot be suspended);
  create an organisation directly and invite its first owner or admin; invite anyone into an approved
  organisation; billing fields (tier, commission %, subscription status: records only, nothing charged).
- **Invites** (`src/lib/orgs/invites.ts`): our own links, `<site>/invite/open#t=<token>`. The token
  rides in the **fragment**, which browsers never send to a server, so it reaches no access log, proxy,
  link scanner's request or Referer; the page at `/invite/open` reads it, wipes it from the address bar
  and hands it over in a same-origin POST (a `?t=` query is never read). The token is 32 random bytes;
  only `HMAC-SHA256(EVENT_CODE_PEPPER, "mb-invite:v1:" + token)` is stored
  (`organization_invites.token_hash`). Single use (claimed with a conditional update), bound to the
  invited email, 7 days, revocable until used. A new invite to the same address withdraws the older
  open ones **the sender could have sent themselves**; an admin inviting an address an owner already
  invited as owner or admin is refused instead. Brakes: 20 invites an hour per organisation, 4 a day
  to one address (hashed key). The link is shown once to whoever sent it and emailed with the branded
  layout (`sendTransactional`, template `staff_invite`, email only; the organisation's name is never
  turned into a link, `noAutolink`); `message_deliveries` keeps the email with the link and token
  replaced by `[removed]` (`redact`, and such a send is never retried from the queue), and neither
  appears in the audit log.
- **Accepting — asked, never silent:** the POST from `/invite/open` moves the token into an httpOnly
  cookie (`__Host-mb_invite`; `mb_invite` on localhost, 1 hour) and redirects to `/invite`, which names
  the organisation and role and masks the address. The person signs in with Google or email + password.
  **A sign-in never accepts an invite and is never blocked by one** (`pendingInviteFor`): when the
  session's confirmed email is the invited one, the server seals who they are for that one invite in a
  15-minute cookie (`__Host-mb_invite_ok`, `sealInviteConfirm`) and the sign-in goes to `/invite`, which
  asks **"Join <organisation> as <role>?"** with **Accept** (`POST /invite/accept`) and **Not now**
  (`POST /invite/decline`). Both are same-origin form POSTs (the route handlers check `Origin`); only
  Accept writes the membership, and it opens the console for that organisation. Any other invite in the
  browser (another address, used, withdrawn, expired, forged) is forgotten at once and the sign-in goes on
  as usual; only a person with nowhere else to go (no membership) sees `/invite?error=…`. Anyone can also
  "Forget this invitation on this device". So a link someone else opened in your browser can neither
  join you to an organisation unasked nor lock you out of your own.
- **What accepting does** (`roleOnAccept` in `roles.ts`): the sender must **still** be able to give that
  role (an active owner, an active admin for manager/referee/operator, or a platform admin); a removed or
  demoted sender's invite is void. Someone already active keeps their role unless the invite raises it
  and the sender may make that change: an invite never lowers anybody. `INVITE_ACCEPTED` is audited with
  the accepting user (`actor_user_id`).

## Members, profile and codes (part B)

- **Members** (`/admin/org/members`, owners and admins **signed in with their own account**): invite,
  change role, remove, withdraw an open invite. Owners give any role; admins give manager / referee /
  operator and cannot touch owners or admins (`mayAssignRole`, `mayRemoveMember` in
  `src/lib/orgs/roles.ts`). Nobody can remove or demote the last owner: the page says so, and the
  database refuses it anyway (trigger `organization_members_keep_owner`, which since 0025 locks the
  organisation's row first, so two simultaneous demotions cannot both pass; deleting the whole
  organisation still cascades). Removal takes effect on the member's next request and withdraws the
  open invites they sent and any to their own address.
- **Profile** (`/admin/org/profile`, owners and admins with their own account): name, logo (PNG/JPEG/WebP,
  bytes sniffed on the server and stored under the sniffed type and extension, 2 MB, at most 2048 px a
  side; every raster upload is capped at 10,000 px a side), colours (`#rrggbb`), about, city, country,
  venues (up to 10), top-board opt-out. The colours and logo are the app skin's defaults for the
  organisation's tournaments that set none of their own (`toSkin` in `src/lib/mobile/projection.ts`).
- **Names** (`orgNameProblem` in `profile.ts`, `orgNameRefusal` in `names.ts`): no web or email address,
  not Move Beyond's names (Move Beyond, Move Score, …), not another approved organisation's name or
  pending rename — compared with case, accents, spaces and punctuation ignored. Checked when applying,
  when a platform admin creates or approves an organisation, and on every rename. A **rename** of an
  approved organisation waits in `organizations.pending_name` (0025) until a platform admin approves it
  (Admin → Organisations → "Name changes waiting", `decideRename`); the public name stays meanwhile. A
  change of case or spacing only applies at once; platform admins rename directly.
- **The shared role passwords never manage members or the profile** (`PERSONAL_ACCOUNT_ONLY` and
  `staffCan` in `src/lib/auth.ts`, used by every guard): a password acting as admin could otherwise
  invite its holder's own email (a membership that outlives the password), remove Move Beyond's real
  members or rebrand it. The nav hides both pages for it.
- **Event codes** (`/admin/org/codes`): expiry choices (1, 3, 7, 30, 90 days or never), the new code shown
  once with a copy button, working codes first.

## In the app (part B)

- `GET /api/mobile/v1/orgs/{slug}` (public, CDN-cached; approved organisations only, status read on every
  request): profile, branding, venues and its public tournaments. Never member emails, codes, the
  application, the plan or billing (`PUBLIC_ORG_COLUMNS`, `toPublicOrg`). Leagues and top boards are
  listed in `comingSoon` until Phase 7; no sample data.
- Every tournament card carries `organization {slug, name}`; the tournament page links "by …" to
  `move-score-app/src/app/org/[slug].tsx`. Follow kind `organization` (key = slug; `FOLLOW_KINDS` in
  `contract.ts`, the follows route, and the `follows.target_kind` check); followed organisations show on
  the Following tab.

## Two gaps closed from the security review

- A profile an organisation only **matched** by a typed mobile (another organisation has the player) now
  shows that organisation the **name typed on its own form** (`organization_players.typed_name`), not the
  profile's public name, everywhere it shows names: admin players and session pages (a name search
  matches the typed name only), the team names its sessions make, and its public session pages, rankings,
  TV ranking and ceremony (`listPublicPlayers(ids, orgId)`, now `orgDisplayNames`). No photo either.
- Staff sign-in brakes end up counting **failed** attempts only: every attempt is counted **before** it
  is checked, atomically (`staffLoginAttempt` → `takeRateLimit`: a compare-and-set on
  `request_counters`, no RPC, so it works on the live project and the stand-in alike), and a right code
  is refunded. Forty referees on one venue Wi-Fi sharing one valid code all sign in; 20 failures per
  address or 40 per code prefix (15 minutes) close the bucket, right code included, and a wave of
  simultaneous guesses gets no more tries than that. Anything not shaped like an event code (a
  shared-password guess) also meets a 6-per-address bucket.

## Security review of Phase 0.5B (fixed)

| Finding | Fix |
|---|---|
| H1 tournament/nation audiences used a matched profile's email/mobile | `playersToRecipients(players, orgId)` uses a linked profile's contact only when the organisation vouches for it (`hiddenPersonFields`); hidden ones are named as typed. Same for the Player codes page and "Send code". |
| M1 matched profile's photo folded onto rosters | `getTeams` and the courts hero skip the photo of a hidden profile (`profilesWithoutPhoto`). |
| M2 shared admin password managed members/profile | `PERSONAL_ACCOUNT_ONLY` permissions need a personal account. |
| M3 staff-login brakes raced | count-before-attempt with compare-and-set, refund on success, small bucket for non-code strings. |
| M4 invites accepted silently; wrong-email cookie locked sign-in | "Join … as …?" with Accept / Not now after sign-in; never blocks a sign-in; cookie forgotten on any mismatch. |
| L1 last-owner race | trigger locks the organisation row (0025). |
| L2 invite cancelled/demoted/outlived | sender-power rules on create and accept; removal withdraws invites. |
| L3 impersonating names, autolinks, invite spam | name rules, renames await approval, `noAutolink`, invite brakes. |
| L4 logo type and size | stored type/extension from the bytes; pixel caps. |
| L5 applications held slugs | placeholder slug until approval. |
| L6 token in the query string | fragment + POST hand-over. Resend **click tracking must stay off** for the sending domain (Resend has no per-email switch; with it on, Resend would rewrite the link and see the token). |
| L7 audit gaps | `INVITE_ACCEPTED` carries the accepting user; platform admins' actions on an organisation are stamped `platform`. |

Every finding has an attack in `scripts/e2e/organizations.ts` (and the pure rules in
`src/lib/orgs/hardening.test.ts`), including a sweep that a profile an organisation only matched shows
none of its real name, photo, email or mobile on any page, export, screen, API, announcement preview,
delivery row or CSV that organisation can reach.

## Event codes

Admin → **Event codes** (`/admin/org/codes`, admins and managers): a code for a referee or a screen
operator, optionally for one tournament or session of the same organisation (the database refuses
any other: trigger `organization_codes_same_org`), optionally expiring. The code is shown once:
12 characters from a 31-symbol alphabet (no 0/O/1/I/L), shown as `XXXX-XXXX-XXXX`; only its
HMAC-SHA256 under the server's `EVENT_CODE_PEPPER` is stored, and it is never written to the audit
log. Sign-in attempts are rate-limited per network address and per code prefix (a short hash of the
first four characters), never platform-wide, so one attacker cannot lock every organisation out
(`src/lib/staffLogin.ts`). Revoke a code there; everyone using it is signed out on their next request.

## Tenant isolation

- Every admin action, page and staff route resolves the organisation from the row itself (match →
  tournament → organisation; session → tournament → organisation; entry → session; announcement,
  event group, season, category and code rows carry their own) through `src/lib/guard.ts`, never from
  an id posted alongside it. A row of another organisation and a missing row get the same answer
  ("Not found", a 404 page, or `404 {"error":"Not found"}`).
- Lists (tournaments, sessions, seasons, rankings, announcements, players, the referee and operator
  pickers, the app's referee list) are filtered by organisation; an event code scoped to one tournament
  sees only it.
- Event groups cannot mix organisations; a new group's slug never reuses another organisation's.
- Announcements reach only the organisation's players (`organization_players`) and its tournaments'
  players and followers; pushes to every app user or to a nation's followers are Move Beyond's.
- Rankings: each organisation has its own seasons (one active at a time), categories (names unique per
  organisation) and lifetime table (`friendly_ranking_snapshots` scope `lifetime`, `scope_id` = the
  organisation). The public `/rankings` shows Move Beyond's unless `?org=<slug>` names another.
- Players: approval, notes and level are each organisation's own (`organization_players`). The
  person's own fields (name, mobile, email, photo, birth year, gender, consent) are changed by an
  organisation only while it is the only one that has the player; merging is for platform admins.
- Person fields are also **seen** only by an organisation that created or added the player, or when no
  other organisation has them (`src/lib/orgs/personFields.ts`). A public registration form that finds
  an existing profile by the typed mobile records the player as `source = 'matched'`: that proves
  nothing about who typed the number, so the organisation sees the name and the entry but not the
  mobile, email, birth year, gender, photo or consents (admin players page, session page, merge
  lists), cannot message them through "all players", and its form never writes their photo or
  WhatsApp consent. Backfilled rows are Move Beyond's (`source = 'backfill'`), so nothing changes for
  Move Beyond. The player can share their details with such an organisation from the app (My profile →
  Organisations, `POST /me/profile/share`), which records `source = 'link'` (Phase 1,
  `docs/player-identity.md`).
  Joining one of its leagues in the app vouches for nothing either: the player becomes the organisation's
  as `matched` (typed name = their public name), and `league` (an organiser approving a member) is
  non-vouching too (`NON_VOUCHING_SOURCES`, `sourceVouches`); only a share makes it `link`.
- Every surface that names players (admin pages, boards, league pages, night tables, the TV, `/f/[slug]`,
  the live courts hero including league nights, the widget and alerts) names them through one rule,
  `orgDisplayNames` (`hiddenPersonFields` + the name typed on the organisation's form): a profile the
  organisation may not show is never named by its public name and lends no photo. Session team names are
  built with it (`loadSessionContext`), so every surface reading `teams.team_name` is masked at source.
- Every id a form posts besides the tournament (a tie, team, court, group, match, profile…) is checked
  against that tournament or organisation before use (`ownershipRefusal` / `entityRefusal` /
  scoped guards); the tie operations themselves also filter by tournament.
- `audit()` records the organisation, the actor (member user id, or `code:<id>`) and the organisation
  role on every staff row; public and app-user flows (`actor_role` `public` / `user`) never get a staff
  role or user stamped on them, even when the browser also carries a staff cookie.
- `src/lib/adminGuards.test.ts` fails the build when an action, page or staff route reaches data
  without these guards, a posted secondary id skips its row guard, or a list is not filtered;
  `scripts/e2e/organizations.ts` is the attack test.
- `supabase/gate/reopen_open_access.sql` (the rollback of closing the gate) never reopens the private
  tables (`organizations`, `organization_members`, `organization_codes`, `platform_admins`,
  `organization_players`, `organization_invites`, `phone_verifications`, `player_link_offers`, `rls_canary`) and revokes them again at the end; `src/lib/gateSql.test.ts`
  fails when a migration from 0023 on creates a table that list does not classify.

## Environment

- `STAFF_SESSION_SECRET` (32+ random characters) signs `mbs1.` tokens. Required in production: without
  it no personal or event-code session works (fails closed); the Move Beyond shared passwords still do.
  Outside production it is derived from `AUTH_SECRET` when unset.
- `EVENT_CODE_PEPPER` (32+ random characters, never in the database) keys the stored event-code
  hashes and the invite-token hashes (domain-separated). Required in production: without it codes can be neither issued nor used (sign-in answers
  "not available"); shared passwords and personal accounts still work. Changing it voids every code.
- Supabase Auth → URL configuration → redirect allow-list: add `https://tour.mbeg.org/staff/auth/callback`
  (and the preview/stand-in origins you use) for Google sign-in on the web.

## Deploy order

1. Close the database gate (`supabase/gate/close_open_access.sql`; see AGENTS.md).
2. Apply `0023_organizations.sql` to the live project (the whole file: part B extended it in place,
   idempotently — `rejected` status, `typed_name`, `organization_invites`, the last-owner trigger and the
   `organization` follow kind), then `0025_org_hardening.sql` (the locking last-owner trigger and
   `organizations.pending_name`; the profile and platform pages read it). **The new code needs them
   first**: every staff sign-in, including the shared passwords, looks up the Move Beyond organisation
   and refuses access (fails closed) when it is missing.
3. Set `STAFF_SESSION_SECRET` and `EVENT_CODE_PEPPER` in Vercel (Production and Preview).
4. Add the web callback to Supabase's redirect allow-list. In Resend, keep **click tracking off** for the
   sending domain (invite links carry their token).
5. Deploy, then run the owner SQL above and sign in with Google at `/login`. From this deploy on the
   shared admin password reaches Move Beyond's tournaments but not Discover or the flags.

## Applying 0023 (locks)

Apply off-peak: the migration runs in one transaction and holds its locks until it commits. It is
ordered so the busiest tables are locked last and briefly:

- `organization_players` is backfilled from `player_profiles` early (blocks new registrations for
  that time only).
- `audit_logs.organization_id` arrives **without a table rewrite**: added with a constant default
  (catalogue only; existing rows read as Move Beyond's), and the default is dropped at once. Its index
  build blocks audit writes while it runs; if `audit_logs` is large, create the column and index by
  hand first, outside a transaction (the migration then skips both):
  ```sql
  -- replace MB_ID with: select id from organizations where slug = 'move-beyond' (after creating the org)
  alter table audit_logs add column if not exists organization_id uuid default 'MB_ID'::uuid;
  alter table audit_logs alter column organization_id drop default;
  create index concurrently if not exists audit_logs_organization_idx on audit_logs (organization_id, created_at desc);
  ```
  (Simpler: run the whole migration off-peak; at today's sizes it takes seconds.)
- `tournaments` (read by every page and TV) is altered at the very end, just before the commit.

Transitional, removed at the end of Phase 0.5: the shared role passwords (Move Beyond only) and the
database default that puts a row without an organisation into Move Beyond (scripts rely on it; the
app always sets the organisation).

## Testing on the stand-in

```
npm run localdb                                    # terminal 1
npm run build                                      # never while `next dev` is up
(set -a; . ./.env.localdb; set +a; PUBLIC_SITE_URL=http://localhost:3077 MESSAGING_DRY_RUN=1 npx next start -p 3077)
npm run e2e:organizations                          # terminal 3
```

`.env.localdb` needs `STAFF_SESSION_SECRET` and `EVENT_CODE_PEPPER` (any 64 hex characters each): the
production build requires them, the attack script signs its forged and expired test tokens with the
first, and inserts its test codes hashed with the second. The script reads server action
ids from `.next/server/server-reference-manifest.json`, so it must run against the build it was built
with. Several scripts sign in through `/api/mobile/v1/staff/session`, which allows 20 attempts per
address and 40 per code prefix per 15 minutes; back-to-back runs on one machine can hit it (clear
the stand-in's `request_counters` rows starting `staff-`, or wait).

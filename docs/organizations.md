# Organisations (Phase 0.5, part A)

Clubs, academies and organisers each run their own tournaments, sessions, event groups, seasons,
ranking categories and announcements. Everything that existed before moved into one organisation,
**Move Beyond** (slug `move-beyond`). Migration: `supabase/migrations/0023_organizations.sql`.

## Who can sign in to the staff console

| Who | How | Token |
|---|---|---|
| Owners, admins, managers (and any member) | `/login` → Google, or email + password (a Move Score account) | our own signed `mbs1.` cookie `{user, org, role, exp}`, 24 h |
| Referees, TV operators | `/login` → event code, or the app's referee screen | `mbs1.` token `{code, org, role, scope, exp}`, 24 h on the web, 7 days in the app, never past the code's expiry |
| Move Beyond only, until retired | the shared role passwords (`ADMIN_PASSWORD` …) | the older `role.expiry.signature` token |

The server checks the Supabase session itself once, at sign-in (`getAuthUser`), then issues its own
cookie and drops the Supabase session. On **every** request (`src/lib/auth/staff.ts`):

- a member's membership must still be `active` (or the person still a platform admin) and the
  organisation still `approved`; the role used is the one in the database now;
- an event code must not be revoked or expired; its role and tournament scope come from the code row;
- shared-password tokens only ever reach the Move Beyond organisation.

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

Check: `select * from platform_admins;` and
`select role, status from organization_members m join organizations o on o.id = m.organization_id where o.slug = 'move-beyond';`

Other organisations and members are created by Move Beyond (Phase 0.5 part B adds applications and
invite links; until then, insert `organizations` / `organization_members` rows by SQL).

## Event codes

Admin → **Event codes** (`/admin/org/codes`, admins and managers): a code for a referee or a screen
operator, optionally for one tournament or session, optionally expiring. The code is shown once:
12 characters from a 31-symbol alphabet (no 0/O/1/I/L), shown as `XXXX-XXXX-XXXX`; only its SHA-256
is stored, and it is never written to the audit log. Sign-in attempts are rate-limited per network
and overall (`src/lib/staffLogin.ts`). Revoke a code there; everyone using it is signed out on their
next request.

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
- `audit()` records the organisation, the actor (member user id, or `code:<id>`) and the organisation
  role on every row.
- `src/lib/adminGuards.test.ts` fails the build when an action, page or staff route reaches data
  without these guards or a list is not filtered; `scripts/e2e/organizations.ts` is the attack test.

## Environment

- `STAFF_SESSION_SECRET` (32+ random characters) signs `mbs1.` tokens. Required in production: without
  it no personal or event-code session works (fails closed); the Move Beyond shared passwords still do.
  Outside production it is derived from `AUTH_SECRET` when unset.
- Supabase Auth → URL configuration → redirect allow-list: add `https://tour.mbeg.org/staff/auth/callback`
  (and the preview/stand-in origins you use) for Google sign-in on the web.

## Deploy order

1. Close the database gate (`supabase/gate/close_open_access.sql`; see AGENTS.md).
2. Apply `0023_organizations.sql` to the live project. **The new code needs it first**: every staff
   sign-in, including the shared passwords, looks up the Move Beyond organisation and refuses access
   (fails closed) when it is missing.
3. Set `STAFF_SESSION_SECRET` in Vercel (Production and Preview).
4. Add the web callback to Supabase's redirect allow-list.
5. Deploy, then run the owner SQL above and sign in with Google at `/login`.

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

`.env.localdb` needs `STAFF_SESSION_SECRET` (any 64 hex characters): the production build requires it
and the attack script signs its forged and expired test tokens with it. The script reads server action
ids from `.next/server/server-reference-manifest.json`, so it must run against the build it was built
with. Several scripts sign in through `/api/mobile/v1/staff/session`, which allows 20 attempts per
address per 15 minutes; back-to-back runs on one machine can hit it (clear the stand-in's
`request_counters` rows starting `staff-`, or wait).

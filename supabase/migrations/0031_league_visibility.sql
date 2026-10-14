-- 0031_league_visibility
--
-- Who can see a league (the owner's three options, src/lib/leagues/visibility.ts):
--
-- 1. leagues.visibility:
--      'everyone'     (default, the behaviour before this migration): an active or
--                     closed league of an approved organisation is public in the app,
--                     on the organisation's page and on the top boards.
--      'org_players'  only the organisation's players (a signed-in account whose own
--                     player profile the organisation has with a vouching source), the
--                     league's members and the organisation's staff.
--      'invite_only'  only the league's members, accounts that entered the league's
--                     current invite code, and the organisation's staff.
--    A league that is not 'everyone' is served only on per-user, never-cached paths;
--    its points never reach the public top boards.
-- 2. league_code_holders: an app account that entered a league's invite code (the
--    existing hashed code, rate-limited). It holds while the code it entered is the
--    league's current one (code_set_at = leagues.invite_code_set_at): a new or
--    cleared code ends it. No code is stored here.
--
-- Security: the new table has row-level security on, NO policy and no grant (like
-- 0027); it is on the never-reopen list in supabase/gate/reopen_open_access.sql.
--
-- Additive and idempotent: safe to run more than once.

alter table leagues add column if not exists visibility text not null default 'everyone';
alter table leagues drop constraint if exists leagues_visibility_check;
alter table leagues add constraint leagues_visibility_check
  check (visibility in ('everyone', 'org_players', 'invite_only'));

create table if not exists league_code_holders (
  league_id uuid not null references leagues(id) on delete cascade,
  auth_user_id uuid not null,
  -- The leagues.invite_code_set_at of the code this account entered.
  code_set_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (league_id, auth_user_id)
);
create index if not exists league_code_holders_user_idx on league_code_holders (auth_user_id);

-- Row-level security: on, with no policy (see header).
alter table league_code_holders enable row level security;
revoke all on league_code_holders from anon, authenticated;

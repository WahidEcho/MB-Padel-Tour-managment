-- 0023_organizations
--
-- Organisations (clubs, academies, organisers) own their tournaments, sessions,
-- event groups, seasons, ranking categories and announcements. Everything that
-- exists today moves into one organisation, Move Beyond (slug move-beyond).
--
-- 1. organizations: slug, name, status applied|approved|suspended, branding,
--    venues, the application form, the plan (free tier, commission %, subscription;
--    nothing is charged in this build) and the top-board opt-out.
-- 2. organization_members: personal staff accounts (Supabase auth user ids) with a
--    role owner|admin|manager|referee|operator and a status invited|active|removed.
--    Membership is re-read on every staff request, so removal takes effect at once.
-- 3. organization_codes: event codes for referees and TV operators. Only an
--    HMAC-SHA256 of a code (keyed with the server's EVENT_CODE_PEPPER) is stored; a
--    code may be scoped to one tournament (or a session's hidden tournament) of its
--    own organisation (enforced by a trigger), may expire, and is revoked by setting
--    revoked_at.
-- 4. platform_admins: Move Beyond's super-admins (auth user ids). Seeded by the
--    owner with the one-line SQL in docs/organizations.md, never by a migration.
-- 5. organization_players: the org-private part of a player (approval, notes,
--    level, categories) for each organisation that has the player. Name, photo,
--    phone and email stay on player_profiles: they belong to the player. `source`
--    says how the player came to the organisation; 'matched' means an existing
--    profile was found by the mobile number typed on the organisation's public
--    form, which proves nothing about who typed it: such an organisation does not
--    see the person's contact fields while another organisation has the player
--    (src/lib/orgs/personFields.ts).
-- 6. organization_id on tournaments, event_groups, seasons, ranking_categories and
--    message_announcements. Sessions, courts, teams, players, matches, the app's
--    announcements and message deliveries derive theirs through the tournament.
--    Ranking category names are unique per organisation; one active season per
--    organisation; lifetime rankings are kept per organisation (scope_id = org).
-- 7. audit_logs.organization_id (actor_user_id already exists; added if missing).
-- 8–12 (part B, at the end): status 'rejected', organization_players.typed_name,
--    organization_invites, the last-owner trigger, and follows of an organisation.
--
-- Transitional: organization_id defaults to Move Beyond's id, so scripts and any
-- code path not yet passing an organisation keep landing where everything lands
-- today. The app sets it explicitly everywhere; the defaults are dropped when the
-- shared role passwords are retired (end of Phase 0.5).
--
-- Security: the new tables have row-level security on and NO policy at all — the
-- server's secret key bypasses RLS, the anon and authenticated keys read nothing
-- (stricter than server_full_access: code hashes and member emails must never be
-- readable with the anon key, even before supabase/gate/close_open_access.sql).
--
-- Additive and idempotent: safe to run more than once.
--
-- Locks (docs/organizations.md, "Applying 0023"): apply off-peak. The statements
-- are ordered so the busiest tables are locked last and for the shortest time —
-- audit_logs gets its column without a table rewrite (a constant default is
-- metadata only, then dropped), and tournaments is altered at the very end, just
-- before the transaction commits. If audit_logs is large, create its index by hand
-- first, outside a transaction:
--   create index concurrently if not exists audit_logs_organization_idx on audit_logs (organization_id, created_at desc);
-- (it needs the column, so: add the column as below, then the index, then run this file).

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$'),
  name text not null check (char_length(name) between 1 and 120),
  status text not null default 'applied' check (status in ('applied', 'approved', 'suspended')),
  logo_url text,
  -- { primary, accent } hex colours for the app skin.
  colors jsonb not null default '{}'::jsonb,
  about text check (about is null or char_length(about) <= 4000),
  city text,
  country text,
  -- [{ name, address, courts }]
  venues jsonb not null default '[]'::jsonb,
  -- What the organisation sent when it applied.
  application jsonb not null default '{}'::jsonb,
  -- { tier, commission_pct, subscription_status, limits }
  plan jsonb not null default '{"tier": "free", "commission_pct": 0, "subscription_status": "none", "limits": {}}'::jsonb,
  top_board_opt_out boolean not null default false,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists platform_admins (
  auth_user_id uuid primary key,
  email text,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  auth_user_id uuid,
  invited_email text,
  role text not null check (role in ('owner', 'admin', 'manager', 'referee', 'operator')),
  status text not null default 'invited' check (status in ('invited', 'active', 'removed')),
  invited_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (auth_user_id is not null or invited_email is not null),
  check (status <> 'active' or auth_user_id is not null)
);
create unique index if not exists organization_members_user_uq
  on organization_members (organization_id, auth_user_id) where auth_user_id is not null;
create index if not exists organization_members_active_idx
  on organization_members (auth_user_id) where status = 'active';

-- Move Beyond owns everything that exists.
insert into organizations (slug, name, status, about)
values ('move-beyond', 'Move Beyond', 'approved', 'Move Beyond tournaments, leagues and sessions.')
on conflict (slug) do nothing;

create table if not exists organization_players (
  organization_id uuid not null references organizations(id) on delete cascade,
  player_profile_id uuid not null references player_profiles(id) on delete cascade,
  approval_status text not null default 'pending' check (approval_status in ('pending', 'approved', 'rejected')),
  notes text,
  level text,
  -- ranking_categories ids of this organisation.
  categories uuid[] not null default '{}',
  first_seen timestamptz not null default now(),
  source text not null default 'admin',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, player_profile_id)
);
-- How the player came to the organisation (see header, 5): backfill (Move Beyond's
-- players before organisations), admin (added by the organisation), registration
-- (a new profile created by its public form), matched (an existing profile found
-- by the mobile typed on its public form), tournament, league, link (a merge or a
-- link the player confirmed).
alter table organization_players drop constraint if exists organization_players_source_check;
alter table organization_players add constraint organization_players_source_check
  check (source in ('backfill', 'admin', 'registration', 'matched', 'tournament', 'league', 'link'));
create index if not exists organization_players_profile_idx on organization_players (player_profile_id);

-- Every existing player profile is one of Move Beyond's players, with the
-- approval, notes, level and categories it has today. Move Beyond created them all.
insert into organization_players (organization_id, player_profile_id, approval_status, notes, level, categories, first_seen, source)
select o.id, p.id,
       case when p.approval_status in ('pending', 'approved', 'rejected') then p.approval_status else 'approved' end,
       p.notes, p.skill_level,
       coalesce((select array_agg(c.ranking_category_id) from player_profile_categories c where c.player_profile_id = p.id), '{}'),
       p.created_at, 'backfill'
from player_profiles p
cross join (select id from organizations where slug = 'move-beyond') o
where p.merged_into_profile_id is null and p.approval_status <> 'merged'
on conflict (organization_id, player_profile_id) do nothing;

-- audit_logs: the column arrives without rewriting the table. A constant default
-- on a new column is stored once in the catalogue (every existing row reads as
-- Move Beyond's), and is dropped again at once: new rows say whose they are.
alter table audit_logs add column if not exists actor_user_id text;
do $$
declare mb uuid;
begin
  select id into mb from organizations where slug = 'move-beyond';
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'audit_logs' and column_name = 'organization_id'
  ) then
    execute format('alter table audit_logs add column organization_id uuid default %L::uuid', mb);
    alter table audit_logs alter column organization_id drop default;
  end if;
end $$;
create index if not exists audit_logs_organization_idx on audit_logs (organization_id, created_at desc);

-- Owning organisation on the other top-level rows (small tables).
alter table event_groups add column if not exists organization_id uuid references organizations(id);
alter table seasons add column if not exists organization_id uuid references organizations(id);
alter table ranking_categories add column if not exists organization_id uuid references organizations(id);
alter table message_announcements add column if not exists organization_id uuid references organizations(id);

do $$
declare mb uuid;
begin
  select id into mb from organizations where slug = 'move-beyond';
  update event_groups set organization_id = mb where organization_id is null;
  update seasons set organization_id = mb where organization_id is null;
  update ranking_categories set organization_id = mb where organization_id is null;
  update message_announcements set organization_id = mb where organization_id is null;
  -- Lifetime rankings were platform-wide (scope_id null); they become Move Beyond's.
  update friendly_ranking_snapshots set scope_id = mb where scope = 'lifetime' and scope_id is null;
  -- Transitional defaults (see header).
  execute format('alter table event_groups alter column organization_id set default %L::uuid', mb);
  execute format('alter table seasons alter column organization_id set default %L::uuid', mb);
  execute format('alter table ranking_categories alter column organization_id set default %L::uuid', mb);
  execute format('alter table message_announcements alter column organization_id set default %L::uuid', mb);
end $$;

alter table event_groups alter column organization_id set not null;
alter table seasons alter column organization_id set not null;
alter table ranking_categories alter column organization_id set not null;
alter table message_announcements alter column organization_id set not null;

create index if not exists event_groups_organization_idx on event_groups (organization_id);
create index if not exists seasons_organization_idx on seasons (organization_id);
create index if not exists message_announcements_organization_idx on message_announcements (organization_id, created_at desc);

-- Category names are unique within an organisation, not across the platform.
alter table ranking_categories drop constraint if exists ranking_categories_name_key;
create unique index if not exists ranking_categories_org_name_uq on ranking_categories (organization_id, name);

-- One active season per organisation (was one for the whole platform).
drop index if exists uq_seasons_single_active;
create unique index if not exists uq_seasons_single_active_per_org on seasons (organization_id) where status = 'active';

-- tournaments last: every page and TV reads it, so it is locked only for these
-- few statements before the commit.
alter table tournaments add column if not exists organization_id uuid references organizations(id);
do $$
declare mb uuid;
begin
  select id into mb from organizations where slug = 'move-beyond';
  update tournaments set organization_id = mb where organization_id is null;
  execute format('alter table tournaments alter column organization_id set default %L::uuid', mb);
end $$;
alter table tournaments alter column organization_id set not null;
create index if not exists tournaments_organization_idx on tournaments (organization_id, kind, created_at desc);

create table if not exists organization_codes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  role text not null check (role in ('referee', 'operator')),
  -- Optional scope: one tournament (or a session's hidden tournament) of the same
  -- organisation (trigger below).
  tournament_id uuid references tournaments(id) on delete cascade,
  -- HMAC-SHA256 (hex) of the normalised code under EVENT_CODE_PEPPER
  -- (src/lib/orgs/codes.ts). The code itself is never stored.
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  label text check (label is null or char_length(label) <= 80),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by uuid,
  created_by_role text,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists organization_codes_org_idx on organization_codes (organization_id, created_at desc);

-- A code's tournament must be one of its own organisation's: the server checks it
-- too, but the database refuses it whatever writes the row.
create or replace function organization_codes_same_org() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.tournament_id is not null and not exists (
    select 1 from tournaments t where t.id = new.tournament_id and t.organization_id = new.organization_id
  ) then
    raise exception 'an event code can only be scoped to a tournament of its own organisation'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists organization_codes_same_org on organization_codes;
create trigger organization_codes_same_org
  before insert or update of tournament_id, organization_id on organization_codes
  for each row execute function organization_codes_same_org();

-- ---------------------------------------------------------------------------
-- Part B (onboarding, invites, profile). 0023 is not on the live project yet, so
-- it is extended here, idempotently, rather than in a new file.
-- ---------------------------------------------------------------------------

-- 8. An application Move Beyond turns down is 'rejected' (kept, never public).
alter table organizations drop constraint if exists organizations_status_check;
alter table organizations add constraint organizations_status_check
  check (status in ('applied', 'approved', 'rejected', 'suspended'));
create index if not exists organizations_status_idx on organizations (status, created_at desc);

-- 9. The name a player gave on an organisation's own registration form. For a
--    profile the organisation only 'matched' by the mobile number typed there, the
--    organisation sees this name instead of the profile's public name while another
--    organisation has the player (src/lib/orgs/personFields.ts): a number typed on
--    a form must not turn into the name of the person it belongs to.
alter table organization_players add column if not exists typed_name text;
alter table organization_players drop constraint if exists organization_players_typed_name_check;
alter table organization_players add constraint organization_players_typed_name_check
  check (typed_name is null or char_length(typed_name) between 1 and 80);

-- 10. Staff invites: single-use links bound to one email address, valid 7 days.
--     Only an HMAC-SHA256 of the link's token (keyed with the server's
--     EVENT_CODE_PEPPER, domain-separated from event codes) is stored; the link
--     itself is shown once to whoever sent it and emailed, never kept. Accepting
--     needs a sign-in with that same (confirmed) email; membership activates then.
create table if not exists organization_invites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  email text not null check (char_length(email) between 3 and 254 and email = lower(email)),
  role text not null check (role in ('owner', 'admin', 'manager', 'referee', 'operator')),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  created_by uuid,
  created_by_role text,
  accepted_at timestamptz,
  accepted_by uuid,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists organization_invites_org_idx on organization_invites (organization_id, created_at desc);

-- 11. Nobody can remove an organisation's last owner: demoting or removing the
--     only active owner is refused by the database, whatever writes the row (the
--     members page checks first and says why).
create or replace function organization_members_keep_owner() returns trigger
language plpgsql
set search_path = public
as $$
declare
  org uuid := coalesce(old.organization_id, new.organization_id);
begin
  -- The organisation itself is being deleted (its members go with it, by cascade).
  if tg_op = 'DELETE' and not exists (select 1 from organizations o where o.id = org) then
    return old;
  end if;
  if old.role = 'owner' and old.status = 'active'
     and (tg_op = 'DELETE' or new.role <> 'owner' or new.status <> 'active' or new.organization_id <> old.organization_id)
     and not exists (
       select 1 from organization_members m
       where m.organization_id = org and m.id <> old.id and m.role = 'owner' and m.status = 'active'
     )
  then
    raise exception 'an organisation must keep at least one owner'
      using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists organization_members_keep_owner on organization_members;
create trigger organization_members_keep_owner
  before update or delete on organization_members
  for each row execute function organization_members_keep_owner();

-- 12. The app can follow an organisation (follows.target_key = its slug).
alter table follows drop constraint if exists follows_target_kind_check;
alter table follows add constraint follows_target_kind_check
  check (target_kind in ('player', 'nation', 'tie', 'match', 'tournament', 'event_group', 'organization'));

-- Row-level security: on, with no policy (see header).
alter table organizations enable row level security;
alter table platform_admins enable row level security;
alter table organization_members enable row level security;
alter table organization_codes enable row level security;
alter table organization_players enable row level security;
alter table organization_invites enable row level security;
revoke all on organizations, platform_admins, organization_members, organization_codes, organization_players, organization_invites from anon, authenticated;

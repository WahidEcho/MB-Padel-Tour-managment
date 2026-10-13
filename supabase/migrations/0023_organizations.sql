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
-- 3. organization_codes: event codes for referees and TV operators. Only the
--    SHA-256 hash of a code is stored; a code may be scoped to one tournament (or a
--    session's hidden tournament), may expire, and is revoked by setting revoked_at.
-- 4. platform_admins: Move Beyond's super-admins (auth user ids). Seeded by the
--    owner with the one-line SQL in docs/organizations.md, never by a migration.
-- 5. organization_players: the org-private part of a player (approval, notes,
--    level, categories) for each organisation that has the player. Name, photo,
--    phone and email stay on player_profiles: they belong to the player.
-- 6. organization_id on tournaments, event_groups, seasons, ranking_categories and
--    message_announcements. Sessions, courts, teams, players, matches, the app's
--    announcements and message deliveries derive theirs through the tournament.
--    Ranking category names are unique per organisation; one active season per
--    organisation; lifetime rankings are kept per organisation (scope_id = org).
-- 7. audit_logs.organization_id (actor_user_id already exists; added if missing).
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

create table if not exists organization_codes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  role text not null check (role in ('referee', 'operator')),
  -- Optional scope: one tournament (or a session's hidden tournament).
  tournament_id uuid references tournaments(id) on delete cascade,
  -- SHA-256 of the normalised code (src/lib/orgs/codes.ts). The code itself is never stored.
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

create table if not exists organization_players (
  organization_id uuid not null references organizations(id) on delete cascade,
  player_profile_id uuid not null references player_profiles(id) on delete cascade,
  approval_status text not null default 'pending' check (approval_status in ('pending', 'approved', 'rejected')),
  notes text,
  level text,
  -- ranking_categories ids of this organisation.
  categories uuid[] not null default '{}',
  first_seen timestamptz not null default now(),
  source text not null default 'admin' check (source in ('backfill', 'admin', 'registration', 'tournament', 'league', 'link')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, player_profile_id)
);
create index if not exists organization_players_profile_idx on organization_players (player_profile_id);

-- Owning organisation on the top-level rows.
alter table tournaments add column if not exists organization_id uuid references organizations(id);
alter table event_groups add column if not exists organization_id uuid references organizations(id);
alter table seasons add column if not exists organization_id uuid references organizations(id);
alter table ranking_categories add column if not exists organization_id uuid references organizations(id);
alter table message_announcements add column if not exists organization_id uuid references organizations(id);
alter table audit_logs add column if not exists organization_id uuid;
alter table audit_logs add column if not exists actor_user_id text;

-- Backfill: Move Beyond owns everything that exists.
insert into organizations (slug, name, status, about)
values ('move-beyond', 'Move Beyond', 'approved', 'Move Beyond tournaments, leagues and sessions.')
on conflict (slug) do nothing;

do $$
declare mb uuid;
begin
  select id into mb from organizations where slug = 'move-beyond';
  update tournaments set organization_id = mb where organization_id is null;
  update event_groups set organization_id = mb where organization_id is null;
  update seasons set organization_id = mb where organization_id is null;
  update ranking_categories set organization_id = mb where organization_id is null;
  update message_announcements set organization_id = mb where organization_id is null;
  update audit_logs set organization_id = mb where organization_id is null;
  -- Lifetime rankings were platform-wide (scope_id null); they become Move Beyond's.
  update friendly_ranking_snapshots set scope_id = mb where scope = 'lifetime' and scope_id is null;
  -- Transitional defaults (see header).
  execute format('alter table tournaments alter column organization_id set default %L::uuid', mb);
  execute format('alter table event_groups alter column organization_id set default %L::uuid', mb);
  execute format('alter table seasons alter column organization_id set default %L::uuid', mb);
  execute format('alter table ranking_categories alter column organization_id set default %L::uuid', mb);
  execute format('alter table message_announcements alter column organization_id set default %L::uuid', mb);
  -- Every existing player profile is one of Move Beyond's players, with the
  -- approval, notes, level and categories it has today.
  insert into organization_players (organization_id, player_profile_id, approval_status, notes, level, categories, first_seen, source)
  select mb, p.id,
         case when p.approval_status in ('pending', 'approved', 'rejected') then p.approval_status else 'approved' end,
         p.notes, p.skill_level,
         coalesce((select array_agg(c.ranking_category_id) from player_profile_categories c where c.player_profile_id = p.id), '{}'),
         p.created_at, 'backfill'
  from player_profiles p
  where p.merged_into_profile_id is null and p.approval_status <> 'merged'
  on conflict (organization_id, player_profile_id) do nothing;
end $$;

alter table tournaments alter column organization_id set not null;
alter table event_groups alter column organization_id set not null;
alter table seasons alter column organization_id set not null;
alter table ranking_categories alter column organization_id set not null;
alter table message_announcements alter column organization_id set not null;

create index if not exists tournaments_organization_idx on tournaments (organization_id, kind, created_at desc);
create index if not exists event_groups_organization_idx on event_groups (organization_id);
create index if not exists seasons_organization_idx on seasons (organization_id);
create index if not exists message_announcements_organization_idx on message_announcements (organization_id, created_at desc);
create index if not exists audit_logs_organization_idx on audit_logs (organization_id, created_at desc);

-- Category names are unique within an organisation, not across the platform.
alter table ranking_categories drop constraint if exists ranking_categories_name_key;
create unique index if not exists ranking_categories_org_name_uq on ranking_categories (organization_id, name);

-- One active season per organisation (was one for the whole platform).
drop index if exists uq_seasons_single_active;
create unique index if not exists uq_seasons_single_active_per_org on seasons (organization_id) where status = 'active';

-- Row-level security: on, with no policy (see header).
alter table organizations enable row level security;
alter table platform_admins enable row level security;
alter table organization_members enable row level security;
alter table organization_codes enable row level security;
alter table organization_players enable row level security;
revoke all on organizations, platform_admins, organization_members, organization_codes, organization_players from anon, authenticated;

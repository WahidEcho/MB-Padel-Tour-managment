-- 0027_leagues
--
-- Leagues (Phase 7): an organisation's recurring competitions, with their own
-- points, monthly boards and top boards.
--
-- 1. leagues: one organisation's league. kind 'nights' (recurring nights, each a
--    friendly session created from the league's night template with a date) or
--    'season' (dated round-robin fixtures per division). status draft|active|
--    closed|archived (the app shows active and closed ones). join_modes: any of
--    open|approval|paid|invite_code (src/lib/leagues/join.ts). The invite code is
--    stored only as an HMAC-SHA256 under the server's EVENT_CODE_PEPPER, domain-
--    separated from event codes (src/lib/leagues/inviteCode.ts); the code itself
--    is shown once to the organiser and never kept. fee: { membership, per_night }
--    (amount + currency; nothing is charged in this build outside Move Beyond).
--    points_rules (src/lib/leagues/points.ts), periods { monthly, boards,
--    year_start_month } (src/lib/leagues/settings.ts), counts_toward_top_of_all,
--    match_day_rules and night_template for the nights it creates, and the time
--    zone a result's month is read in.
-- 2. league_divisions: a league has one or more divisions.
-- 3. league_members: a player profile in a league (one row per league and
--    profile), its division, the app account that asked (if any), status
--    pending|awaiting_payment|active|removed, pay-at-venue flag, paid_until, and
--    an optional partner for season fixtures played as pairs.
-- 4. league_fixtures: what a division plays, with the date its results count on
--    (their month = this date in the league's time zone): a night (a friendly
--    session), a season fixture (one match of the division's season session, with
--    its two members), or a tournament that counts toward the division.
-- 5. league_points: what each player banked from each league match. Unique per
--    match + profile, so a retried finalise or a correction can never count twice.
-- 6. tournaments.counts_toward: the one division a tournament counts toward (off
--    when null). A trigger refuses a division of another organisation.
--
-- Security: every new table has row-level security on and NO policy (like 0023):
-- the server's secret key bypasses RLS; the anon and authenticated keys read
-- nothing (invite-code hashes, members' accounts and organisers' decisions are
-- private). They are on the never-reopen list in supabase/gate/reopen_open_access.sql.
--
-- Additive and idempotent: safe to run more than once.

create table if not exists leagues (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{0,78}[a-z0-9]$'),
  name text not null check (char_length(name) between 1 and 120),
  about text check (about is null or char_length(about) <= 4000),
  sport text not null default 'padel',
  kind text not null default 'nights' check (kind in ('nights', 'season')),
  status text not null default 'draft' check (status in ('draft', 'active', 'closed', 'archived')),
  join_modes text[] not null default '{open}',
  -- HMAC-SHA256 (hex) of the normalised invite code; null = no code set.
  invite_code_hash text check (invite_code_hash is null or invite_code_hash ~ '^[0-9a-f]{64}$'),
  invite_code_set_at timestamptz,
  -- { membership: { amount, currency } | null, per_night: { amount, currency } | null }
  fee jsonb not null default '{}'::jsonb,
  points_rules jsonb not null default '{"win": 2, "draw": 1.5, "loss": 1, "walkover_win": 2, "walkover_loss": 0, "streak": {"on": false, "bonus": 1, "from": 2, "to": 11}}'::jsonb,
  periods jsonb not null default '{"monthly": true, "boards": [1, 3, 12], "year_start_month": 1}'::jsonb,
  counts_toward_top_of_all boolean not null default true,
  match_day_rules jsonb not null default '{}'::jsonb,
  night_template jsonb not null default '{}'::jsonb,
  timezone text not null default 'Africa/Cairo',
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists leagues_organization_idx on leagues (organization_id, status, created_at desc);

create table if not exists league_divisions (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  sort_order integer not null default 1,
  -- A season division's matches run on one hidden friendly session.
  season_session_id uuid references friendly_sessions(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (league_id, name)
);
create index if not exists league_divisions_league_idx on league_divisions (league_id, sort_order);

create table if not exists league_members (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  division_id uuid references league_divisions(id) on delete set null,
  player_profile_id uuid not null references player_profiles(id) on delete cascade,
  partner_profile_id uuid references player_profiles(id) on delete set null,
  -- The app account that asked to join (null when the organiser added the player).
  auth_user_id uuid,
  status text not null default 'pending' check (status in ('pending', 'awaiting_payment', 'active', 'removed')),
  pay_at_venue boolean not null default false,
  paid_until date,
  source text not null default 'app' check (source in ('app', 'admin')),
  decided_at timestamptz,
  decided_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (league_id, player_profile_id)
);
create index if not exists league_members_division_idx on league_members (division_id, status);
create index if not exists league_members_profile_idx on league_members (player_profile_id);
create index if not exists league_members_user_idx on league_members (auth_user_id) where auth_user_id is not null;

create table if not exists league_fixtures (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  division_id uuid not null references league_divisions(id) on delete cascade,
  kind text not null check (kind in ('night', 'match', 'tournament')),
  session_id uuid references friendly_sessions(id) on delete cascade,
  tournament_id uuid references tournaments(id) on delete cascade,
  match_id uuid references matches(id) on delete cascade,
  home_member_id uuid references league_members(id) on delete set null,
  away_member_id uuid references league_members(id) on delete set null,
  round integer,
  date date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (kind = 'night' and session_id is not null and match_id is null and tournament_id is null)
    or (kind = 'match' and session_id is not null and match_id is not null and tournament_id is null)
    or (kind = 'tournament' and tournament_id is not null and session_id is null and match_id is null)
  )
);
create unique index if not exists league_fixtures_match_uq on league_fixtures (match_id) where match_id is not null;
create unique index if not exists league_fixtures_night_uq on league_fixtures (session_id) where kind = 'night';
create unique index if not exists league_fixtures_tournament_uq on league_fixtures (tournament_id) where kind = 'tournament';
create index if not exists league_fixtures_division_idx on league_fixtures (division_id, date);
create index if not exists league_fixtures_league_idx on league_fixtures (league_id, date);
create index if not exists league_fixtures_session_idx on league_fixtures (session_id) where session_id is not null;

create table if not exists league_points (
  id bigint generated by default as identity primary key,
  league_id uuid not null references leagues(id) on delete cascade,
  division_id uuid references league_divisions(id) on delete set null,
  player_profile_id uuid not null references player_profiles(id) on delete cascade,
  match_id uuid not null references matches(id) on delete cascade,
  kind text not null check (kind in ('win', 'draw', 'loss', 'walkover_win', 'walkover_loss')),
  -- { base, streak }
  components jsonb not null default '{}'::jsonb,
  points numeric(6, 1) not null,
  -- "YYYY-MM": the night or fixture date's month in the league's time zone.
  month text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  streak_after integer not null default 0,
  games_won integer not null default 0,
  games_lost integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (match_id, player_profile_id)
);
create index if not exists league_points_league_month_idx on league_points (league_id, month);
create index if not exists league_points_profile_idx on league_points (player_profile_id, month);

-- A division of another organisation's league can never be named: by a tournament
-- counting toward it, a fixture, or a member row. The server checks first; the
-- database refuses it whatever writes the row.
create or replace function league_rows_same_org() returns trigger
language plpgsql
set search_path = public
as $$
declare
  lg uuid;
  league_org uuid;
begin
  if tg_table_name = 'tournaments' then
    if new.counts_toward is null then return new; end if;
    select l.organization_id into league_org
      from league_divisions d join leagues l on l.id = d.league_id
      where d.id = new.counts_toward;
    if league_org is null or league_org <> new.organization_id then
      raise exception 'a tournament can only count toward a league of its own organisation'
        using errcode = '23514';
    end if;
    return new;
  end if;

  lg := new.league_id;
  select organization_id into league_org from leagues where id = lg;
  if new.division_id is not null and not exists (
    select 1 from league_divisions d where d.id = new.division_id and d.league_id = lg
  ) then
    raise exception 'that division is not part of this league' using errcode = '23514';
  end if;
  if tg_table_name = 'league_fixtures' then
    if new.session_id is not null and not exists (
      select 1 from friendly_sessions s join tournaments t on t.id = s.tournament_id
      where s.id = new.session_id and t.organization_id = league_org
    ) then
      raise exception 'a league can only use sessions of its own organisation' using errcode = '23514';
    end if;
    if new.tournament_id is not null and not exists (
      select 1 from tournaments t where t.id = new.tournament_id and t.organization_id = league_org
    ) then
      raise exception 'a league can only use tournaments of its own organisation' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists league_members_same_org on league_members;
create trigger league_members_same_org
  before insert or update of league_id, division_id on league_members
  for each row execute function league_rows_same_org();
drop trigger if exists league_fixtures_same_org on league_fixtures;
create trigger league_fixtures_same_org
  before insert or update of league_id, division_id, session_id, tournament_id on league_fixtures
  for each row execute function league_rows_same_org();

-- tournaments last (every page and TV reads it).
alter table tournaments add column if not exists counts_toward uuid references league_divisions(id) on delete set null;
drop trigger if exists tournaments_counts_toward_same_org on tournaments;
create trigger tournaments_counts_toward_same_org
  before insert or update of counts_toward, organization_id on tournaments
  for each row execute function league_rows_same_org();

-- Row-level security: on, with no policy (see header).
alter table leagues enable row level security;
alter table league_divisions enable row level security;
alter table league_members enable row level security;
alter table league_fixtures enable row level security;
alter table league_points enable row level security;
revoke all on leagues, league_divisions, league_members, league_fixtures, league_points from anon, authenticated;

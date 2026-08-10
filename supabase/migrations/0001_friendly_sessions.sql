-- ===================================================================
-- 0001_friendly_sessions
--
-- Adds Friendly Sessions: casual play sessions with persistent player
-- profiles, seasons, flexible pairing, and Session/Season/Lifetime
-- individual rankings with fire-streak bonus points.
--
-- Design notes (see DECISIONS.md):
--  * Each friendly session owns a hidden backing row in `tournaments`
--    (kind = 'friendly_session'), so the whole existing scoring stack —
--    referee screen, offline queue, events sync, device locks, snapshots,
--    TV modes — works unchanged. Pairs are `teams` rows; friendly matches
--    are `matches` rows with stage = 'friendly' (verified: `stage` is
--    unconstrained text, so no change is needed there).
--  * `player_score_ledger.id` is the AUTHORITATIVE ordering for fire-streak
--    replay. Never order fire history by a client timestamp: offline devices
--    sync late and their clocks drift.
--  * The ledger carries a `source` discriminator from day one so tournament
--    results can later feed the same Season/Lifetime rankings without a
--    schema change. Only 'friendly' is written today.
--  * `player_profiles.auth_user_id` / `claim_status` are forward-compatibility
--    columns for a possible future player login. Nothing reads them yet.
--
-- Fully idempotent: safe to run more than once.
-- ===================================================================

-- ---------- 1. Persistent player identity ----------

create table if not exists player_profiles (
  id uuid primary key default gen_random_uuid(),
  public_name text not null,
  -- Canonical (E.164-ish) form. Nullable so admins can add a player with no
  -- phone; unique so self-registration can detect duplicates. Postgres allows
  -- many NULLs under a unique constraint, which is what we want.
  mobile_normalized text unique,
  approval_status text not null default 'pending'
    check (approval_status in ('pending','approved','rejected','merged')),
  -- Cache of the live fire streak. Always rebuildable from the ledger.
  active_streak int not null default 0,
  streak_last_ledger_id bigint,
  -- Set when this profile was merged into another; points at the survivor.
  merged_into_profile_id uuid references player_profiles(id),
  -- Forward compatibility for a future player login. Unused today.
  auth_user_id uuid unique,
  claim_status text not null default 'unclaimed'
    check (claim_status in ('unclaimed','claimed')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_player_profiles_approval
  on player_profiles (approval_status);
create index if not exists idx_player_profiles_name
  on player_profiles (lower(public_name));

-- ---------- 2. Seasons and ranking categories ----------

create table if not exists seasons (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  starts_on date,
  ends_on date,
  status text not null default 'active'
    check (status in ('upcoming','active','closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- At most one active season. Enforced here as well as in app logic.
create unique index if not exists uq_seasons_single_active
  on seasons ((status)) where status = 'active';

create table if not exists ranking_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists player_profile_categories (
  player_profile_id uuid not null references player_profiles(id) on delete cascade,
  ranking_category_id uuid not null references ranking_categories(id) on delete cascade,
  primary key (player_profile_id, ranking_category_id)
);

-- ---------- 3. Friendly sessions ----------

create table if not exists friendly_sessions (
  id uuid primary key default gen_random_uuid(),
  -- The hidden backing tournament row that carries courts + scoring_config.
  tournament_id uuid not null unique references tournaments(id) on delete cascade,
  season_id uuid references seasons(id),
  slug text not null unique,
  name text not null,
  status text not null default 'draft'
    check (status in ('draft','open','scheduled','live','completed','finalized')),
  starts_at timestamptz,
  duration_minutes int not null default 120,
  registration_deadline timestamptz,
  expected_match_minutes int not null default 30,
  turnover_minutes int not null default 5,
  pairing_mode text not null default 'fixed'
    check (pairing_mode in ('fixed','americano','mexicano')),
  -- 'no_new_matches' blocks starts past the cutoff; 'open' lets them run on.
  cutoff_policy text not null default 'no_new_matches'
    check (cutoff_policy in ('no_new_matches','open')),
  cutoff_extended_minutes int not null default 0,
  max_players int,
  visibility text not null default 'public'
    check (visibility in ('public','unlisted')),
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_friendly_sessions_season on friendly_sessions (season_id);
create index if not exists idx_friendly_sessions_status on friendly_sessions (status);

-- ---------- 4. Registration ----------

create table if not exists friendly_entries (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references friendly_sessions(id) on delete cascade,
  player_profile_id uuid not null references player_profiles(id) on delete cascade,
  source text not null default 'self' check (source in ('self','admin')),
  approval text not null default 'pending'
    check (approval in ('pending','approved','waitlisted','rejected','withdrawn')),
  preferred_partner_profile_id uuid references player_profiles(id),
  checked_in boolean not null default false,
  -- Ordering for waitlist promotion.
  registered_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, player_profile_id)
);

create index if not exists idx_friendly_entries_session_approval
  on friendly_entries (session_id, approval);
create index if not exists idx_friendly_entries_waitlist
  on friendly_entries (session_id, registered_at) where approval = 'waitlisted';

-- ---------- 5. Pairs (versioned) ----------

create table if not exists friendly_pairs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references friendly_sessions(id) on delete cascade,
  -- The backing `teams` row this pair plays as.
  team_id uuid not null references teams(id) on delete cascade,
  player_one_profile_id uuid not null references player_profiles(id),
  player_two_profile_id uuid references player_profiles(id),
  label text,
  -- Versioning: a partner change retires the old pair and creates a new one,
  -- so completed matches keep pointing at the pair that actually played.
  active_from_round int not null default 1,
  retired_after_round int,
  created_at timestamptz not null default now()
);

create index if not exists idx_friendly_pairs_session on friendly_pairs (session_id);
create unique index if not exists uq_friendly_pairs_team on friendly_pairs (team_id);

-- ---------- 6. Immutable match participant snapshot ----------

-- Written at match creation; the historical truth about who actually played,
-- even if pairs are re-versioned afterwards. Only the audited correction
-- action may rewrite a row here.
create table if not exists friendly_match_participants (
  match_id uuid primary key references matches(id) on delete cascade,
  session_id uuid not null references friendly_sessions(id) on delete cascade,
  pair_a_id uuid references friendly_pairs(id),
  pair_b_id uuid references friendly_pairs(id),
  team_a_player_one uuid not null references player_profiles(id),
  team_a_player_two uuid references player_profiles(id),
  team_b_player_one uuid not null references player_profiles(id),
  team_b_player_two uuid references player_profiles(id),
  round_number int,
  created_at timestamptz not null default now()
);

create index if not exists idx_friendly_participants_session
  on friendly_match_participants (session_id);

-- ---------- 7. Points ledger ----------

create table if not exists player_score_ledger (
  -- Server-assigned monotonic order. THE authoritative sequence for fire
  -- replay. Do not order fire history by any client-supplied timestamp.
  id bigint generated by default as identity primary key,
  player_profile_id uuid not null references player_profiles(id) on delete cascade,
  match_id uuid not null references matches(id) on delete cascade,
  -- 'friendly' today. 'tournament' reserved so tournament results can feed
  -- the same Season/Lifetime rankings later without a migration.
  source text not null default 'friendly' check (source in ('friendly','tournament')),
  session_id uuid references friendly_sessions(id) on delete cascade,
  tournament_id uuid references tournaments(id) on delete cascade,
  season_id uuid references seasons(id),
  component text not null check (component in ('base_win','fire')),
  points int not null,
  status text not null default 'provisional'
    check (status in ('provisional','official')),
  created_at timestamptz not null default now(),
  -- Idempotency: a retried offline sync can never double-award.
  unique (match_id, player_profile_id, component)
);

create index if not exists idx_ledger_player_order
  on player_score_ledger (player_profile_id, id);
create index if not exists idx_ledger_scope
  on player_score_ledger (source, season_id, player_profile_id);
create index if not exists idx_ledger_session
  on player_score_ledger (session_id);

-- ---------- 8. Ranking snapshots ----------

create table if not exists friendly_ranking_snapshots (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('session','season','lifetime')),
  -- NULL for lifetime.
  scope_id uuid,
  player_profile_id uuid not null references player_profiles(id) on delete cascade,
  rank int not null,
  points int not null default 0,
  base_points int not null default 0,
  fire_points int not null default 0,
  wins int not null default 0,
  losses int not null default 0,
  games_won int not null default 0,
  games_lost int not null default 0,
  game_diff int not null default 0,
  matches_played int not null default 0,
  active_streak int not null default 0,
  calculated_at timestamptz not null default now()
);

-- coalesce() so the lifetime scope (NULL scope_id) still gets one row/player.
create unique index if not exists uq_ranking_snapshot_scope
  on friendly_ranking_snapshots
  (scope, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid), player_profile_id);

-- ---------- 9. Rate limiting for the public registration endpoint ----------

create table if not exists request_counters (
  bucket_key text primary key,
  window_started_at timestamptz not null default now(),
  count int not null default 0
);

create index if not exists idx_request_counters_window
  on request_counters (window_started_at);

-- ---------- 10. Additive changes to existing tables ----------

-- Distinguishes real tournaments from friendly-session backing rows so the
-- tournament lists can filter them out.
alter table tournaments
  add column if not exists kind text not null default 'tournament';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tournaments_kind_check'
  ) then
    alter table tournaments
      add constraint tournaments_kind_check
      check (kind in ('tournament','friendly_session'));
  end if;
end $$;

create index if not exists idx_tournaments_kind on tournaments (kind);

-- Links a per-tournament player row to a persistent profile. Nullable:
-- existing tournament players stay unlinked until an admin matches them.
alter table players
  add column if not exists player_profile_id uuid references player_profiles(id);

create index if not exists idx_players_profile on players (player_profile_id);

-- 0022_match_day
--
-- Match day: the rules a tournament runs its day by, calling matches to court,
-- and the tables Live Activities started by push will need.
--
-- 1. tournaments.match_day_rules: src/lib/matchday/rules.ts. '{}' reads as all
--    off, so every existing tournament behaves exactly as before until an
--    organiser saves the Match day tab; new tournaments are created with the
--    defaults on. tournaments.starts_at: when the first match starts (refunds and
--    "soon" are measured from it).
-- 2. matches.result_source: how a finished result was recorded: point_by_point, a
--    final score entered in one go (final_score), or a final score that replaced a
--    partly scored or finished match (correction, audited). Null for everything
--    before this, and while a match is not finished.
-- 3. match_calls: one row per match called to its court (deadline, extensions,
--    who is present, how the no-show prompt was answered).
-- 4. live_activity_start_tokens / live_activity_starts: an iPhone's push-to-start
--    token, and which activities were started for it (once per match and phase).
-- 5. Both scoring_mode checks also take 'either' (the referee picks per match), and
--    a new friendly session defaults to it, so a session can defer to the
--    tournament's rules.
--
-- Additive and idempotent: safe to run more than once. Every new table gets the
-- same server_full_access policy as every other table today (see 0015);
-- supabase/gate/close_open_access.sql removes them all together.

alter table tournaments add column if not exists match_day_rules jsonb not null default '{}'::jsonb;
alter table tournaments add column if not exists starts_at timestamptz;

alter table matches add column if not exists result_source text check (result_source in ('point_by_point', 'final_score', 'correction'));

-- "Court busy" and "next on court" look up a court's live and ready matches.
create index if not exists matches_court_status_idx on matches (court_id, status);

create table if not exists match_calls (
  match_id uuid primary key references matches(id) on delete cascade,
  tournament_id uuid not null references tournaments(id) on delete cascade,
  court_id uuid references courts(id) on delete set null,
  called_at timestamptz not null default now(),
  deadline_at timestamptz not null,
  extensions integer not null default 0,
  a_present_at timestamptz,
  b_present_at timestamptz,
  status text not null default 'called' check (status in ('called', 'started', 'walkover', 'cancelled')),
  -- The referee's answer to the no-show prompt: { action, side, at }.
  answer jsonb,
  called_by_role text,
  device_id text,
  updated_at timestamptz not null default now()
);
create index if not exists match_calls_tournament_idx on match_calls (tournament_id, status);

create table if not exists live_activity_start_tokens (
  installation_id text primary key,
  token text not null unique,
  updated_at timestamptz not null default now(),
  disabled_at timestamptz
);

create table if not exists live_activity_starts (
  installation_id text not null,
  match_id uuid not null references matches(id) on delete cascade,
  phase text not null,
  created_at timestamptz not null default now(),
  unique (installation_id, match_id, phase)
);

alter table friendly_sessions drop constraint if exists friendly_sessions_scoring_mode_check;
alter table friendly_sessions add constraint friendly_sessions_scoring_mode_check
  check (scoring_mode in ('point_by_point', 'final_score', 'either'));
alter table friendly_sessions alter column scoring_mode set default 'either';

alter table matches drop constraint if exists matches_scoring_mode_override_check;
alter table matches add constraint matches_scoring_mode_override_check
  check (scoring_mode_override is null or scoring_mode_override in ('point_by_point', 'final_score', 'either'));

-- Same posture as every existing table until the gate closes (see header).
alter table match_calls enable row level security;
drop policy if exists server_full_access on match_calls;
create policy server_full_access on match_calls for all to anon, authenticated using (true) with check (true);

alter table live_activity_start_tokens enable row level security;
drop policy if exists server_full_access on live_activity_start_tokens;
create policy server_full_access on live_activity_start_tokens for all to anon, authenticated using (true) with check (true);

alter table live_activity_starts enable row level security;
drop policy if exists server_full_access on live_activity_starts;
create policy server_full_access on live_activity_starts for all to anon, authenticated using (true) with check (true);

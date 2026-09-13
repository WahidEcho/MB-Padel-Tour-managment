-- ===================================================================
-- 0006_presence
--
-- "N watching": who is on a public page right now.
--
-- A browser on a public page posts a heartbeat every 20 seconds; a visitor
-- counts while their last beat is inside a 60-second window. Deliberately not
-- Supabase Realtime: that needs a publishable key in the browser, and the rule
-- in AGENTS.md is that no Supabase key ships to the client until RLS has been
-- tightened. A heartbeat against our own route needs no key at all.
--
-- What is stored is an opaque per-browser id and a timestamp. No address, no
-- user agent, nothing joinable to a player: `visitor_id` is generated in the
-- browser and means nothing anywhere else in the schema — in particular it is
-- NOT the referee's `mb_device_id`, which identifies the device holding a
-- match's scoring lock.
--
-- Rows are swept by the endpoint itself, five minutes after they stop counting.
-- Nothing here relies on a scheduler: pg_cron is not installed, and the one
-- existing housekeeping function in the codebase (pruneRateLimitCounters) is
-- never called by anything, which is exactly the trap this avoids.
--
-- Also fixes a pre-existing inconsistency. The sixteen tables from the initial
-- schema all have RLS enabled with a single `server_full_access` policy; the
-- twelve added for friendly sessions were created without it. Since every query
-- in this app runs server-side through one service key, enabling RLS with the
-- same permissive policy changes no behaviour — it only brings those tables
-- back in line and clears twelve security-advisor errors.
--
-- Fully idempotent: safe to run more than once.
-- ===================================================================

-- ---------- 1. The table ----------

create table if not exists page_presence (
  page_key text not null,
  visitor_id text not null,
  last_seen timestamptz not null default now(),
  primary key (page_key, visitor_id)
);

-- Bounds on a table written from an unauthenticated endpoint. The key is built
-- server-side and is at most "t:<uuid>:leaderboard"; the id is a uuid.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'page_presence_page_key_length') then
    alter table page_presence
      add constraint page_presence_page_key_length check (char_length(page_key) <= 120);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'page_presence_visitor_id_length') then
    alter table page_presence
      add constraint page_presence_visitor_id_length check (char_length(visitor_id) <= 40);
  end if;
end $$;

-- NOTE: 0007 drops both of these again. Measured after the feature ran, they
-- cost every heartbeat its HOT-update eligibility (last_seen is rewritten on
-- each beat, and an indexed column changing rules out an in-place update) while
-- the planner never chose either one over the primary key. Left here because an
-- applied migration is never edited.
create index if not exists idx_page_presence_key_seen on page_presence (page_key, last_seen);
create index if not exists idx_page_presence_seen on page_presence (last_seen);

-- ---------- 2. RLS, matching the initial schema ----------

alter table page_presence enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'page_presence' and policyname = 'server_full_access'
  ) then
    create policy server_full_access on page_presence
      for all to anon, authenticated using (true) with check (true);
  end if;
end $$;

-- ---------- 3. Bring the friendly-session tables back in line ----------

do $$
declare
  t text;
begin
  foreach t in array array[
    'friendly_sessions', 'friendly_entries', 'friendly_pairs', 'friendly_match_participants',
    'friendly_ranking_snapshots', 'player_profiles', 'player_consents', 'player_score_ledger',
    'player_profile_categories', 'ranking_categories', 'seasons', 'request_counters'
  ]
  loop
    if exists (select 1 from pg_tables where schemaname = 'public' and tablename = t) then
      execute format('alter table public.%I enable row level security', t);
      if not exists (
        select 1 from pg_policies
        where schemaname = 'public' and tablename = t and policyname = 'server_full_access'
      ) then
        execute format(
          'create policy server_full_access on public.%I for all to anon, authenticated using (true) with check (true)',
          t
        );
      end if;
    end if;
  end loop;
end $$;

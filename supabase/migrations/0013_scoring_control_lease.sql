-- ===================================================================
-- 0013_scoring_control_lease
--
-- Replaces matches.active_scoring_device_id — a permanent lock with no way for
-- two referees to hand a match between themselves — with a renewable lease.
--
-- A lease is live while released_at is null and expires_at is in the future.
-- The controlling device renews it every few seconds; if it stops (a closed
-- tab, a dead phone, a lost connection for good) the lease goes stale on its
-- own and the very next device to open the match just takes it — no approval
-- needed, because nobody is there to ask. While a lease IS live, a second
-- device can only ask: request_transfer writes into transfer_request, and only
-- the holding device (device_id must match) may accept or decline it.
--
-- One row per match, so `match_id` is unique and the row is looked up the way
-- match_score_snapshots already is. `revision` is the same optimistic-
-- concurrency guard src/lib/screens.ts already uses for screen_settings: every
-- write is conditioned on the revision just read, and a miss means someone
-- else won the race — re-read and report the truth rather than overwrite it.
--
-- matches.active_scoring_device_id is left in place but stops being written to
-- — this repo's own convention for a replaced column (0010 added
-- teams.voice_name_text, 0011 dropped it once proven unused; this column can
-- be dropped the same way in a later migration).
--
-- Fully idempotent: safe to run more than once.
-- ===================================================================

create table if not exists scoring_leases (
  id                uuid primary key default gen_random_uuid(),
  match_id          uuid not null unique references matches(id) on delete cascade,
  tournament_id     uuid not null references tournaments(id) on delete cascade,
  device_id         text not null,
  device_label      text,
  revision          integer not null default 0,
  acquired_at       timestamptz not null default now(),
  renewed_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  released_at       timestamptz,
  transfer_request  jsonb
);

create index if not exists idx_scoring_leases_tournament on scoring_leases (tournament_id);

-- Bounds on text this app writes itself (a client-generated device id and a
-- short derived label), matching the length-check style already used for
-- page_presence in 0006.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'scoring_leases_device_id_length') then
    alter table scoring_leases
      add constraint scoring_leases_device_id_length check (char_length(device_id) <= 80);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'scoring_leases_device_label_length') then
    alter table scoring_leases
      add constraint scoring_leases_device_label_length check (device_label is null or char_length(device_label) <= 60);
  end if;
end $$;

-- RLS, matching every other table: one permissive policy, since every query
-- runs server-side through the service key and no Supabase key ever reaches
-- the browser (see 0006's note on the same rule).
alter table scoring_leases enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'scoring_leases' and policyname = 'server_full_access'
  ) then
    create policy server_full_access on scoring_leases
      for all to anon, authenticated using (true) with check (true);
  end if;
end $$;

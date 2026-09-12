-- ===================================================================
-- 0005_screens
--
-- One row per display, not one per tournament.
--
-- `screen_settings` already had UNIQUE (tournament_id, screen_key), but every
-- reader and writer hard-coded the key 'main', so a venue could only ever drive
-- one wall. A real event has a screen per court group plus a lobby screen, each
-- covering different courts and each with its own link.
--
-- What each column is for:
--  * screen_name    what the operator calls it; screen_key is its URL and is
--                   immutable, because a TV may already be open on it.
--  * court_ids      which courts this screen covers. EMPTY MEANS ALL COURTS, so
--                   every screen that existed before this migration keeps
--                   showing what it showed.
--  * focus_match_id pins the screen to one match. Together with focus_court_id
--                   this is the whole "following live vs pinned" state: the
--                   absence of both IS follow-live. There is deliberately no
--                   third `mode` flag that could disagree with them.
--  * bracket_tier   which bracket the bracket/winner/ceremony scenes show, once
--                   there are two of them.
--  * revision       bumped by every write and checked by every writer, so two
--                   operators on two devices cannot silently overwrite each
--                   other. Same discipline as the match events endpoint.
--  * break_*        a server-stamped break, so a screen that reloads mid-break
--                   rejoins the same countdown instead of restarting it.
--  * mute_animations, ceremony_step*, entrance_replay
--                   operator controls whose rendering lands with the broadcast
--                   layer; the storage is here so that work needs no migration.
--
-- Fully idempotent: safe to run more than once.
-- ===================================================================

-- ---------- 1. Identity and coverage ----------

alter table screen_settings add column if not exists screen_name text;
alter table screen_settings add column if not exists court_ids uuid[] not null default '{}';
alter table screen_settings add column if not exists focus_match_id uuid references matches(id) on delete set null;
alter table screen_settings add column if not exists bracket_tier text not null default 'cup';

-- ---------- 2. Concurrent operators ----------

alter table screen_settings add column if not exists revision int not null default 0;

-- ---------- 3. Operator controls ----------

alter table screen_settings add column if not exists break_started_at timestamptz;
alter table screen_settings add column if not exists break_ends_at timestamptz;
alter table screen_settings add column if not exists mute_animations boolean not null default false;
alter table screen_settings add column if not exists ceremony_step int not null default 0;
alter table screen_settings add column if not exists ceremony_step_at timestamptz;
alter table screen_settings add column if not exists entrance_replay jsonb;

-- ---------- 4. Constrain what can reach a wall ----------
-- display_mode had no allowlist at all, so a typo or a stray form value stored
-- fine and rendered an empty screen. 'live_court' and 'all_live' are the two
-- pre-existing modes, kept valid and read as aliases of 'live': coverage and
-- the pin decide what a live screen shows, so one mode is enough.

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'screen_settings_display_mode_check') then
    alter table screen_settings
      add constraint screen_settings_display_mode_check
      check (display_mode in (
        'live', 'leaderboard', 'bracket', 'winner', 'ceremony', 'sponsors', 'holding',
        'live_court', 'all_live'
      ));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'screen_settings_bracket_tier_check') then
    alter table screen_settings
      add constraint screen_settings_bracket_tier_check
      check (bracket_tier in ('cup', 'plate', 'both'));
  end if;
end $$;

-- ---------- 5. The one hot query without an index ----------
-- The venue screen reads every snapshot for its tournament on each poll.

create index if not exists idx_match_score_snapshots_tournament
  on match_score_snapshots (tournament_id);

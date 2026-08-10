-- ===================================================================
-- 0002_ranking_models_and_consent
--
-- 1. Two ranking models per session (see DECISIONS.md §1):
--      'win_points' — 3 points per win + fire streak (the house rule)
--      'games_won'  — each player banks the games their side won, so a
--                     6-4 set gives the winners 6 each and the losers 4 each.
--                     This is the Americano philosophy adapted to set scoring,
--                     and it is what makes the Mexicano court ladder meaningful.
--    Matches themselves ALWAYS use the existing padel engine (sets/games).
--    There is no rally-to-N scoring anywhere and no second scoring engine.
--
-- 2. Mexicano within-court pairing convention. Three mutually incompatible
--    conventions ship in the wild; one widely-cited source calls its own
--    "universally accepted" and is simply wrong. Default to the balanced one
--    but let each session choose, because clubs migrating from another app
--    will expect their existing behaviour.
--
-- 3. Per-player, per-channel consent records for Egypt's PDPL. Mobile numbers
--    are already stored, so this is added before any messaging ships.
--    SMS is deliberately absent — dropped from scope.
--
-- Fully idempotent: safe to run more than once.
-- ===================================================================

-- ---------- 1. Session ranking model + Mexicano pairing ----------

alter table friendly_sessions
  add column if not exists ranking_model text not null default 'win_points';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'friendly_sessions_ranking_model_check') then
    alter table friendly_sessions
      add constraint friendly_sessions_ranking_model_check
      check (ranking_model in ('win_points','games_won'));
  end if;
end $$;

alter table friendly_sessions
  add column if not exists mexicano_pairing text not null default 'balanced_1_4';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'friendly_sessions_mexicano_pairing_check') then
    alter table friendly_sessions
      add constraint friendly_sessions_mexicano_pairing_check
      check (mexicano_pairing in ('balanced_1_4','semi_1_3','top_heavy_1_2'));
  end if;
end $$;

-- Seed for the round-1 random draw. Stored so a regenerated schedule is
-- reproducible and auditable rather than silently different each time.
alter table friendly_sessions
  add column if not exists draw_seed bigint;

-- ---------- 2. Ledger gains a 'games' component ----------

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'player_score_ledger_component_check') then
    alter table player_score_ledger drop constraint player_score_ledger_component_check;
  end if;
  alter table player_score_ledger
    add constraint player_score_ledger_component_check
    check (component in ('base_win','fire','games'));
end $$;

-- ---------- 3. PDPL consent ----------

-- Current consent state per player per channel. Historical changes are
-- captured in audit_logs; this table answers "may we message them now?".
create table if not exists player_consents (
  id uuid primary key default gen_random_uuid(),
  player_profile_id uuid not null references player_profiles(id) on delete cascade,
  channel text not null check (channel in ('whatsapp','web_push','email')),
  granted boolean not null default false,
  granted_at timestamptz,
  revoked_at timestamptz,
  -- How the consent was captured, for the audit trail.
  source text not null default 'registration'
    check (source in ('registration','admin','player')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (player_profile_id, channel)
);

create index if not exists idx_player_consents_lookup
  on player_consents (player_profile_id, channel) where granted;

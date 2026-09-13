-- ===================================================================
-- 0008_bracket_tiers
--
-- One group stage, two knockout brackets.
--
--   Cup   — the teams placed 1st and 2nd in each group (what exists today).
--   Plate — the teams placed 3rd and 4th, drawn and played separately, so
--           nobody goes home after the group stage.
--
-- Two columns carry the whole idea.
--
-- brackets.tier tells the two apart, with a unique index so a double submit or
-- two admins cannot produce two 'cup' rows — which would make getBracket()
-- order-dependent while the first row's slots and matches lingered. Every
-- existing bracket is a Cup, and every tournament currently has at most one
-- (verified: 4 brackets across 4 tournaments), so the index is safe to add.
--
-- matches.bracket_id is the piece without which none of this works. Both tiers
-- produce a match with stage 'final' and round_name 'F', so without it:
--   * the referee list, admin table, public schedule and venue screen would all
--     show two identically-labelled matches with nothing to tell them apart;
--   * podiumFromMatches would find whichever final it happened to hit first;
--   * per-stage match rules could not give the Plate final its own rules;
--   * and a scoped delete would have nothing to scope by.
--
-- ON DELETE SET NULL, not CASCADE: removing a bracket must never take scored
-- matches with it. The deliberate cascade is done in code, in a fixed order,
-- by deleteBracketCascade.
--
-- Fully idempotent: safe to run more than once.
-- ===================================================================

-- ---------- 1. Which bracket is which ----------

alter table brackets add column if not exists tier text not null default 'cup';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'brackets_tier_check') then
    alter table brackets add constraint brackets_tier_check check (tier in ('cup', 'plate'));
  end if;
end $$;

create unique index if not exists uq_brackets_tournament_tier on brackets (tournament_id, tier);

-- ---------- 2. Which bracket a match belongs to ----------

alter table matches
  add column if not exists bracket_id uuid references brackets(id) on delete set null;

create index if not exists idx_matches_bracket on matches (bracket_id);

-- Existing knockout matches belong to their tournament's one bracket. Without
-- this, a tournament mid-knockout would lose its bracket labelling the moment
-- the new column started being read.
update matches m
set bracket_id = b.id
from brackets b
where m.tournament_id = b.tournament_id
  and b.tier = 'cup'
  and m.stage <> 'group'
  and m.stage <> 'friendly'
  and m.bracket_id is null;

-- ---------- 3. A Plate entrant is not eliminated ----------
-- applyQualification stamps everyone below the qualifying places 'eliminated'.
-- Ranks that go on to play a Plate get their own status instead, or half the
-- field reads as knocked out on the public leaderboard the moment groups finish.
--
-- No DDL needed: standings_snapshots.status is unconstrained text (verified), so
-- the union in src/lib/types.ts is the contract. Constraining it now would be a
-- tightening unrelated to this change, and would risk rejecting a value the
-- existing code can already write.

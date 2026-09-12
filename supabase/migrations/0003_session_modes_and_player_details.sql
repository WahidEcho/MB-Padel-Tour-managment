-- ===================================================================
-- 0003_session_modes_and_player_details
--
-- 1. Registration mode per session: individuals, teams, or either.
--    Rotating formats (Americano/Mexicano) are individual by nature;
--    fixed-partner sessions want both players captured in one submission.
-- 2. Scoring mode per session, with a referee override per match: full
--    point-by-point, or just the final score.
-- 3. Session duration becomes optional — organisers asked not to be forced
--    into a time box, and the capacity estimate is advice, not a cap.
-- 4. Structured optional player details (email, birth year, level) instead of
--    stuffing everything into a free-text note.
-- 5. Rejections are hidden, never destroyed, so a mistaken reject is
--    recoverable and a player can re-apply.
--
-- Fully idempotent: safe to run more than once.
-- ===================================================================

-- ---------- 1. Registration mode ----------

alter table friendly_sessions
  add column if not exists registration_mode text not null default 'individual';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'friendly_sessions_registration_mode_check') then
    alter table friendly_sessions
      add constraint friendly_sessions_registration_mode_check
      check (registration_mode in ('individual','team','either'));
  end if;
end $$;

-- ---------- 2. Scoring mode ----------

alter table friendly_sessions
  add column if not exists scoring_mode text not null default 'point_by_point';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'friendly_sessions_scoring_mode_check') then
    alter table friendly_sessions
      add constraint friendly_sessions_scoring_mode_check
      check (scoring_mode in ('point_by_point','final_score'));
  end if;
end $$;

-- Per-match override, so one court can run quick entry while another is
-- scored ball by ball. Null means "use the session default".
alter table matches
  add column if not exists scoring_mode_override text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'matches_scoring_mode_override_check') then
    alter table matches
      add constraint matches_scoring_mode_override_check
      check (scoring_mode_override is null or scoring_mode_override in ('point_by_point','final_score'));
  end if;
end $$;

-- ---------- 3. Duration is optional ----------

alter table friendly_sessions alter column duration_minutes drop not null;
alter table friendly_sessions alter column duration_minutes drop default;

-- ---------- 4. Structured player details ----------

alter table player_profiles add column if not exists email text;
alter table player_profiles add column if not exists birth_year int;
-- Free-form so clubs can use their own vocabulary (A/B/C, 1-7, beginner…).
alter table player_profiles add column if not exists skill_level text;
alter table player_profiles add column if not exists gender text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'player_profiles_birth_year_check') then
    alter table player_profiles
      add constraint player_profiles_birth_year_check
      check (birth_year is null or (birth_year between 1900 and 2100));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'player_profiles_gender_check') then
    alter table player_profiles
      add constraint player_profiles_gender_check
      check (gender is null or gender in ('male','female','other'));
  end if;
end $$;

create index if not exists idx_player_profiles_level on player_profiles (skill_level);

-- ---------- 5. Recoverable rejections ----------

-- Rejected entries stay in the table. `hidden` keeps them out of the working
-- list without destroying the record, so a mistaken reject can be undone and
-- a player who re-applies simply becomes pending again.
alter table friendly_entries add column if not exists hidden boolean not null default false;
alter table friendly_entries add column if not exists rejected_at timestamptz;
alter table friendly_entries add column if not exists rejection_note text;

create index if not exists idx_friendly_entries_visible
  on friendly_entries (session_id, approval) where not hidden;

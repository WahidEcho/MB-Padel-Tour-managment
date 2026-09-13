-- ===================================================================
-- 0004_player_photos
--
-- Portraits that survive a venue screen.
--
-- 1. Persistent player profiles had no photo column at all: a tournament
--    `players` row could carry a photo, a friendly-session player could not.
--    Sessions were therefore permanently photoless on the wall.
-- 2. Framing becomes metadata, not a destructive crop. `object-fit: cover` on
--    a square card crops whatever the camera happened to centre, which on a
--    wide shot means a cropped-off head. A focal point lets every size — a
--    28px avatar and a 320px broadcast portrait — keep the face in frame from
--    the same stored file.
-- 3. Two URLs per person: a transparent cut-out portrait for the big cards,
--    and the original photo as a fallback. Readers prefer the cut-out and fall
--    back, so a missing one is never a broken image.
--
-- The default focal point is (0.5, 0.35): horizontally centred, and above the
-- middle, because faces sit in the upper third of almost every portrait.
--
-- Fully idempotent: safe to run more than once.
-- ===================================================================

-- ---------- 1. Persistent profiles gain a photo ----------

alter table player_profiles add column if not exists photo_url text;
alter table player_profiles add column if not exists portrait_url text;
alter table player_profiles add column if not exists focal_x real not null default 0.5;
alter table player_profiles add column if not exists focal_y real not null default 0.35;

-- ---------- 2. Tournament players gain framing ----------

alter table players add column if not exists portrait_url text;
alter table players add column if not exists focal_x real not null default 0.5;
alter table players add column if not exists focal_y real not null default 0.35;

-- ---------- 3. Keep the focal point inside the frame ----------
-- A slider or a hand-edited value outside 0..1 renders object-position off the
-- image with no visible cause, so it is refused at the column.

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'players_focal_check') then
    alter table players
      add constraint players_focal_check
      check (focal_x between 0 and 1 and focal_y between 0 and 1);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'player_profiles_focal_check') then
    alter table player_profiles
      add constraint player_profiles_focal_check
      check (focal_x between 0 and 1 and focal_y between 0 and 1);
  end if;
end $$;

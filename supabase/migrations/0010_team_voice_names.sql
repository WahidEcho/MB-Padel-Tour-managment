-- ===================================================================
-- 0010_team_voice_names
--
-- The voice umpire calls teams by name ("Advantage, Falcons."). Each team's name
-- is a short recorded clip in the umpire's voice, made in the organiser's browser.
--
-- voice_name_text is how the name should be SAID, when that differs from how it
-- is written: "Wa-heed and Nasser" for "Wahid & Nasser", or English letters for a
-- name written in Arabic. Null means say the team name as written.
--
-- The clip itself is not referenced from the row. It is stored under a key derived
-- from the words spoken and the voice (voice-names/<key>.wav), so a pair that plays
-- again in a later round or session, or a cloned tournament, finds its clip
-- without making it again, and a clip never needs deleting when a team changes.
--
-- Fully idempotent: safe to run more than once.
-- ===================================================================

alter table teams add column if not exists voice_name_text text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'teams_voice_name_text_length') then
    alter table teams add constraint teams_voice_name_text_length
      check (voice_name_text is null or char_length(voice_name_text) <= 80);
  end if;
end $$;

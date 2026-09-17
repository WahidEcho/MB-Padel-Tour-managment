-- ===================================================================
-- 0011_drop_team_voice_names
--
-- Reverses 0010. The voice umpire no longer calls teams by their own names; the
-- organiser can instead turn on red and blue teams (branding_config.redBlueTeams),
-- which needs no per-team data at all. voice_name_text was never written by
-- released code.
--
-- Fully idempotent: safe to run more than once.
-- ===================================================================

alter table teams drop constraint if exists teams_voice_name_text_length;
alter table teams drop column if exists voice_name_text;

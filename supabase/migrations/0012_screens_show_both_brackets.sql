-- ===================================================================
-- 0012_screens_show_both_brackets
--
-- Every screen ever created was born with bracket_tier = 'cup', because that was
-- the column's default, and until now nothing in the operator console let anyone
-- change it outside the ceremony card. So an organiser who published a Plate
-- bracket saw the Cup alone on the wall with no setting that explained why.
--
-- 'both' is now the default for a new screen, and this brings existing ones with
-- it. It cannot hide anything: the bracket, winner and ceremony scenes resolve
-- 'both' to every published bracket, so a tournament running only a Cup shows
-- exactly what it showed before.
--
-- Idempotent: the second run matches no rows.
-- ===================================================================

alter table screen_settings alter column bracket_tier set default 'both';

update screen_settings set bracket_tier = 'both' where bracket_tier = 'cup';

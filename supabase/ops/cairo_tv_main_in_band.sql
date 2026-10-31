-- Cairo events' TV screens (owner, 31 Oct 2026): Midar (the master sponsor) loops in the TV sponsor band with
-- the other partners instead of standing still on its left. Only branding_config.tvMainInBand changes; the app,
-- the website and the sponsors slate are untouched. Needs the build that reads tvMainInBand (src/lib/sponsors.ts
-- tvSponsorBand). Undo: untick "On the TVs, the main sponsor loops…" in Admin -> Settings -> Branding.

update tournaments
set branding_config = jsonb_set(branding_config, '{tvMainInBand}', 'true'::jsonb),
    updated_at = now()
where slug in ('davis-cup-junior-finals-2026', 'bjk-cup-junior-finals-2026')
returning slug, branding_config->'tvMainInBand' as tv_main_in_band;
-- Expect 2 rows.

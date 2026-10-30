-- Cairo events' public pages (owner, 30 Oct 2026): the public-page backgrounds drawn from each event's court-TV
-- artwork, and no "Powered by Move Beyond" under the title. Changes only these keys of branding_config:
-- background.publicUrl, background.showOnPublic and hidePoweredBy. The court-TV background is untouched.
-- Undo: set showOnPublic false / remove hidePoweredBy (or untick the switch in Admin -> Settings -> Branding).

update tournaments t
set branding_config = jsonb_set(
      jsonb_set(
        t.branding_config,
        '{background}',
        (t.branding_config->'background') || jsonb_build_object(
          'showOnPublic', true,
          'publicUrl', case when t.slug = 'davis-cup-junior-finals-2026'
                            then '/backgrounds/cairo-2026/dc-public.svg'
                            else '/backgrounds/cairo-2026/bjk-public.svg' end)),
      '{hidePoweredBy}', 'true'::jsonb),
    updated_at = now()
where t.slug in ('davis-cup-junior-finals-2026', 'bjk-cup-junior-finals-2026')
returning slug, branding_config->'background' as background, branding_config->'hidePoweredBy' as hide_powered_by;
-- Expect 2 rows.

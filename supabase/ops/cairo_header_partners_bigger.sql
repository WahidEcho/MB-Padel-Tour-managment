-- Court TV header partners 15% bigger on both Cairo events (owner, 31 Oct 2026):
-- Egyptian Tennis Federation 57 → 66 px, World Tennis 39 → 45 px. Same as Admin → Screens → Court TV design → header partner height.
update tournaments t set branding_config = jsonb_set(t.branding_config, '{headerPartners}', (
  select jsonb_agg(case p->>'name'
    when 'Egyptian Tennis Federation' then jsonb_set(p, '{height}', to_jsonb(66))
    when 'World Tennis' then jsonb_set(p, '{height}', to_jsonb(45))
    else p end order by ord)
  from jsonb_array_elements(t.branding_config->'headerPartners') with ordinality as x(p, ord)))
where slug in ('davis-cup-junior-finals-2026', 'bjk-cup-junior-finals-2026')
returning slug, branding_config->'headerPartners' as header_partners;

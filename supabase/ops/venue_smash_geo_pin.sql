-- Smash Sporting Club venue maps (Davis Cup + BJK Cup): tie the map to the owner's Google Maps pin.
--
-- The owner's pin (29 Oct 2026): 30.1177648, 31.3991591 = the club's south-west outer wall corner on
-- Airport Rd. On the club's site plan that corner is plan point (157.64, 42.92) m. The anchor
-- (doc.geo.lat/lng) is the plan's (0,0), so it is set to the point 157.64 m west and 42.92 m south of the
-- pin, which puts that corner exactly on the pin. Rotation goes back to 0 (the plan is drawn north up;
-- 180 mirrored the GPS dot and compass).
--
-- Only doc.geo changes; every drawn point stays as it is. Each row is updated only while its geo is
-- still the one read on 29 Oct (rotation 180), so a newer save from the editor is never overwritten.

update venue_maps
set doc = jsonb_set(doc, '{geo}', '{"lat": 30.1173788, "lng": 31.3975202, "rotationDeg": 0, "scale": 1}'::jsonb),
    version = version + 1,
    updated_at = now()
where id in ('fea1626d-06e8-43e0-8849-0def8424a225', '8f7b5ec7-776d-4e89-b451-639ab385c920')
  and (doc->'geo'->>'rotationDeg')::numeric = 180
returning id, version, doc->'geo' as geo;
-- Expect 2 rows: fea1626d… (Davis Cup) and 8f7b5ec7… (BJK Cup), both version 9.

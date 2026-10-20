-- 0041: referee PIN brakes (audit H1, 20 Oct 2026). After a court code the referee picks
-- their own name, so wrong PINs are counted per referee and per organisation
-- (request_counters, no schema change). A device that signed a referee in during the last
-- 24 h gets back in with the right PIN while that referee is locked: the sign-in row
-- records a peppered hash of the device (src/lib/referees/pin.ts hashRefereeDevice:
-- "app:<installation id>" or "web:<random browser id>"), never the id itself.
-- Idempotent; no new table, no policy, no grant (referee_sessions keeps RLS on, anon and
-- authenticated revoked since 0035).

alter table referee_sessions add column if not exists device_hash text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'referee_sessions_device_hash_shape') then
    alter table referee_sessions add constraint referee_sessions_device_hash_shape
      check (device_hash is null or device_hash ~ '^[0-9a-f]{64}$');
  end if;
end $$;

create index if not exists referee_sessions_device_idx on referee_sessions (referee_id, device_hash, signed_in_at desc) where device_hash is not null;

alter table referee_sessions enable row level security;
revoke all on referee_sessions from anon, authenticated;

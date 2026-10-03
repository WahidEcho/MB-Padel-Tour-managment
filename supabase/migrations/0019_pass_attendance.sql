-- Move Score pass: attendees only, and match attendance.
--
-- * The pass is the attendee's. Staff accreditation lives in the referee console,
--   never on the pass: until now a phone that had signed in to the referee console
--   sent its staff token with every personal call, and opening the pass turned it
--   into a permanent "Referee · All courts" accreditation. Those passes go back to
--   the attendee edition. (The edition column stays for older app builds; the
--   server only writes 'spectator' now.)
-- * Scanning the check-in code at a match (court TV corner, or the printed code at
--   the court) records that the pass attended it, once per pass per match.
-- * Points are a ledger, so later games add their own kinds next to 'attendance'.
--   The rule that decides the points is src/lib/pass/attendance.ts.
--
-- Idempotent. Additive apart from the edition reset. Apply to the live project
-- BEFORE deploying the code that uses it.

update event_passes set edition = 'spectator', staff_role = null where edition = 'staff';

create table if not exists pass_attendances (
  pass_id uuid not null references event_passes(id) on delete cascade,
  match_id uuid not null references matches(id) on delete cascade,
  -- Which code was scanned: the rotating one on the court TV, or the printed one.
  via text not null check (via in ('screen', 'printed')),
  created_at timestamptz not null default now(),
  primary key (pass_id, match_id)
);
create index if not exists pass_attendances_match_idx on pass_attendances(match_id);

create table if not exists pass_points (
  id uuid primary key default gen_random_uuid(),
  pass_id uuid not null references event_passes(id) on delete cascade,
  kind text not null check (kind in ('attendance')),
  -- What earned them: for 'attendance', the match id.
  ref_id text not null,
  points integer not null check (points between 0 and 1000),
  -- How the points were made up, e.g. {"parts": [{"label": "Final", "points": 10}]}.
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (pass_id, kind, ref_id)
);
create index if not exists pass_points_pass_idx on pass_points(pass_id);

-- Same posture as every other table until supabase/gate/close_open_access.sql runs.
do $$
declare t text;
begin
  foreach t in array array['pass_attendances', 'pass_points']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists server_full_access on %I', t);
    execute format('create policy server_full_access on %I for all to anon, authenticated using (true) with check (true)', t);
  end loop;
end $$;

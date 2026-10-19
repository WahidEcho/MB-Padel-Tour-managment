-- 0035_referees.sql — personal referee PINs, master referees, calls for assistance
-- (Junior Finals, Cairo, from 2 Nov 2026). Docs: docs/referees.md.
--
-- 1. referees: the organisation's referee roster (optionally limited to one event
--    group). Each person has a 4-digit PIN, stored only as an HMAC-SHA256 under the
--    server's EVENT_CODE_PEPPER, keyed by organisation (src/lib/referees/pin.ts):
--    unique among the organisation's active referees. role 'master_referee' covers
--    every court of the organisation's events (or of its event group).
-- 2. organization_codes: a court code (0034) now needs a referee PIN to sign in; a
--    new role 'master_referee' is a master referee's personal code (referee_id), also
--    used with that person's PIN. A master code is never a court code.
-- 3. referee_sessions: one row per PIN sign-in (who, which code / court, via web or
--    app, last seen), for "On court now" and the history. Tokens name their row, so a
--    PIN reset or a removal ends the sessions at once.
-- 4. assistance_calls: "Call for assistance" from a court referee to the master
--    referees on duty: requested → acknowledged ("On my way") → resolved, at most one
--    open call per physical court (repeated taps join it).
-- 5. audit_logs.actor_name / actor_referee_id: which referee did it.
--
-- Idempotent. RLS on for every new table, no policy, nothing granted to anon /
-- authenticated (the server's secret key bypasses RLS).

-- 1. The roster -------------------------------------------------------------------
create table if not exists referees (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  -- Optional: only the codes of this event group (both events of the Junior Finals).
  event_group_id uuid references event_groups(id) on delete set null,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  phone text check (phone is null or char_length(phone) <= 32),
  photo_url text check (photo_url is null or (char_length(photo_url) <= 500 and photo_url ~ '^https?://')),
  role text not null default 'referee' check (role in ('referee', 'master_referee')),
  -- HMAC-SHA256 (hex) of "<organisation>:<PIN>" under EVENT_CODE_PEPPER. Never the PIN.
  pin_hash text not null check (pin_hash ~ '^[0-9a-f]{64}$'),
  -- A token signed before this is refused (a PIN reset signs the person out everywhere).
  pin_set_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active', 'removed')),
  created_by uuid,
  created_by_role text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One PIN per active referee of an organisation: a PIN alone names the person.
create unique index if not exists referees_active_pin_idx on referees (organization_id, pin_hash) where status = 'active';
create index if not exists referees_org_idx on referees (organization_id, status, name);

create or replace function referees_same_org() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.event_group_id is not null and not exists (
    select 1 from event_groups g where g.id = new.event_group_id and g.organization_id = new.organization_id
  ) then
    raise exception 'a referee can only be limited to an event group of its own organisation'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists referees_same_org on referees;
create trigger referees_same_org
  before insert or update of event_group_id, organization_id on referees
  for each row execute function referees_same_org();

alter table referees enable row level security;
revoke all on referees from anon, authenticated;

-- 2. Master referee codes ----------------------------------------------------------
alter table organization_codes
  add column if not exists referee_id uuid references referees(id) on delete cascade;

alter table organization_codes drop constraint if exists organization_codes_role_check;
alter table organization_codes add constraint organization_codes_role_check
  check (role in ('referee', 'operator', 'master_referee'));

alter table organization_codes drop constraint if exists organization_codes_master_shape;
alter table organization_codes add constraint organization_codes_master_shape check (
  (role = 'master_referee') = (referee_id is not null)
  and (role <> 'master_referee' or court_name is null)
);

-- 0034's court scope, widened: a master referee code may cover an event group (no court).
alter table organization_codes drop constraint if exists organization_codes_court_scope;
alter table organization_codes add constraint organization_codes_court_scope check (
  (court_name is null and (event_group_id is null or role = 'master_referee'))
  or (
    court_name is not null
    and role = 'referee'
    and char_length(btrim(court_name)) between 1 and 60
    and ((tournament_id is null) <> (event_group_id is null))
  )
);

create or replace function organization_codes_same_org() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.tournament_id is not null and not exists (
    select 1 from tournaments t where t.id = new.tournament_id and t.organization_id = new.organization_id
  ) then
    raise exception 'an event code can only be scoped to a tournament of its own organisation'
      using errcode = '23514';
  end if;
  if new.event_group_id is not null and not exists (
    select 1 from event_groups g where g.id = new.event_group_id and g.organization_id = new.organization_id
  ) then
    raise exception 'an event code can only be scoped to an event group of its own organisation'
      using errcode = '23514';
  end if;
  if new.referee_id is not null and not exists (
    select 1 from referees r where r.id = new.referee_id and r.organization_id = new.organization_id and r.role = 'master_referee'
  ) then
    raise exception 'a master referee code must belong to a master referee of its own organisation'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists organization_codes_same_org on organization_codes;
create trigger organization_codes_same_org
  before insert or update of tournament_id, event_group_id, referee_id, organization_id on organization_codes
  for each row execute function organization_codes_same_org();

create index if not exists organization_codes_referee_idx on organization_codes (referee_id) where referee_id is not null;

alter table organization_codes enable row level security;
revoke all on organization_codes from anon, authenticated;

-- 3. Who is signed in where --------------------------------------------------------
create table if not exists referee_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  referee_id uuid not null references referees(id) on delete cascade,
  code_id uuid references organization_codes(id) on delete set null,
  role text not null check (role in ('referee', 'master_referee')),
  -- The court code's court ("Court 1"); null for a master referee.
  court_name text check (court_name is null or char_length(court_name) <= 60),
  event_group_id uuid references event_groups(id) on delete set null,
  tournament_id uuid references tournaments(id) on delete set null,
  via text not null check (via in ('web', 'app', 'app_legacy')),
  -- The phone (push_devices.installation_id), for a master referee's alerts.
  installation_id text check (installation_id is null or char_length(installation_id) between 16 and 80),
  signed_in_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  end_reason text check (end_reason is null or end_reason in ('signed_out', 'replaced', 'pin_reset', 'removed'))
);
create index if not exists referee_sessions_org_idx on referee_sessions (organization_id, last_seen_at desc);
create index if not exists referee_sessions_referee_idx on referee_sessions (referee_id, signed_in_at desc);

alter table referee_sessions enable row level security;
revoke all on referee_sessions from anon, authenticated;

-- 4. Calls for assistance ----------------------------------------------------------
create table if not exists assistance_calls (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  event_group_id uuid references event_groups(id) on delete set null,
  tournament_id uuid references tournaments(id) on delete set null,
  match_id uuid references matches(id) on delete set null,
  court_name text not null check (char_length(btrim(court_name)) between 1 and 60),
  -- courtKey(court_name) and the event group (or tournament) it is in: one open call per court.
  court_key text not null check (char_length(court_key) between 1 and 60),
  scope_key uuid not null,
  code_id uuid references organization_codes(id) on delete set null,
  requested_by uuid references referees(id) on delete set null,
  requested_by_name text not null check (char_length(requested_by_name) between 1 and 80),
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved', 'cancelled')),
  requested_at timestamptz not null default now(),
  -- Taps on the button while the call is open (each one is not a new call).
  taps integer not null default 1,
  last_tap_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid references referees(id) on delete set null,
  acknowledged_by_name text check (acknowledged_by_name is null or char_length(acknowledged_by_name) <= 80),
  resolved_at timestamptz,
  resolved_by uuid references referees(id) on delete set null,
  resolved_by_name text check (resolved_by_name is null or char_length(resolved_by_name) <= 80),
  -- How many phones the alert went to (master referees on duty).
  alerted integer not null default 0,
  check (status not in ('acknowledged') or acknowledged_at is not null),
  check (status not in ('resolved', 'cancelled') or resolved_at is not null)
);
create unique index if not exists assistance_calls_one_open_idx
  on assistance_calls (organization_id, scope_key, court_key) where status in ('open', 'acknowledged');
create index if not exists assistance_calls_org_idx on assistance_calls (organization_id, requested_at desc);

alter table assistance_calls enable row level security;
revoke all on assistance_calls from anon, authenticated;

-- 5. Which referee did it ----------------------------------------------------------
alter table audit_logs add column if not exists actor_name text;
alter table audit_logs add column if not exists actor_referee_id uuid;
create index if not exists audit_logs_referee_idx on audit_logs (actor_referee_id, created_at desc) where actor_referee_id is not null;

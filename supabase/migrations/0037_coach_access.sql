-- 0037_coach_access.sql — national team coach access (Junior Finals, Cairo, from 2 Nov 2026).
-- Docs: docs/coaches.md.
--
-- 1. coach_codes: one access code per team (a nation in one event: "Egypt · Davis Cup
--    Juniors"; the Egyptian girls' team has its own). The head coach and every assistant
--    sign in with the same code; there is no personal PIN. Like other event codes the code
--    is random (src/lib/orgs/codes.ts), looked up by its HMAC-SHA256 under EVENT_CODE_PEPPER
--    (`code_hash`), and kept sealed (`code_sealed`, AES-256-GCM under a key derived from the
--    same pepper) so the organiser can print the team's card again. Revocable; expires at
--    the end of the event. At most one working (unrevoked) code per team.
-- 2. coach_sessions: one row per sign-in (web or app; the phone's installation id for the
--    alerts), last seen, ended. Tokens name their row; revoking the code ends them all.
--
-- A coach is never staff: coach tokens ("mbc1.") are not staff tokens, reach only the
-- /coach pages and /api/mobile/v1/coach routes, and only their own team's ties, rubbers,
-- line-ups and match logs (src/lib/coaches/). Nothing else in the database changes.
--
-- Idempotent. RLS on for both tables, no policy, nothing granted to anon / authenticated
-- (the server's secret key bypasses RLS).

-- 1. The codes ---------------------------------------------------------------------
create table if not exists coach_codes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  tournament_id uuid not null references tournaments(id) on delete cascade,
  team_id uuid not null references teams(id) on delete cascade,
  -- HMAC-SHA256 (hex) of the normalised code under EVENT_CODE_PEPPER. Never the code.
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  -- The code sealed for reprinting the team's card ("v1.<iv>.<tag>.<body>").
  code_sealed text check (code_sealed is null or (char_length(code_sealed) <= 200 and code_sealed like 'v1.%')),
  label text check (label is null or char_length(label) <= 120),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_by uuid,
  created_by_role text,
  created_at timestamptz not null default now()
);
-- One working code per team: "New code" revokes the old one first.
create unique index if not exists coach_codes_one_live_idx on coach_codes (team_id) where revoked_at is null;
create index if not exists coach_codes_org_idx on coach_codes (organization_id, tournament_id, created_at desc);

-- A code's team must be its tournament's, and its tournament its organisation's.
create or replace function coach_codes_same_org() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (
    select 1 from tournaments t where t.id = new.tournament_id and t.organization_id = new.organization_id
  ) then
    raise exception 'a coach code can only be for a tournament of its own organisation'
      using errcode = '23514';
  end if;
  if not exists (
    select 1 from teams m where m.id = new.team_id and m.tournament_id = new.tournament_id
  ) then
    raise exception 'a coach code can only be for a team of its own tournament'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists coach_codes_same_org on coach_codes;
create trigger coach_codes_same_org
  before insert or update of organization_id, tournament_id, team_id on coach_codes
  for each row execute function coach_codes_same_org();

alter table coach_codes enable row level security;
revoke all on coach_codes from anon, authenticated;

-- 2. Who is signed in with a code ----------------------------------------------------
create table if not exists coach_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  code_id uuid not null references coach_codes(id) on delete cascade,
  team_id uuid not null references teams(id) on delete cascade,
  via text not null check (via in ('web', 'app')),
  -- The phone (push_devices.installation_id), for the team's alerts.
  installation_id text check (installation_id is null or char_length(installation_id) between 16 and 80),
  signed_in_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  end_reason text check (end_reason is null or end_reason in ('signed_out', 'revoked', 'replaced'))
);
create index if not exists coach_sessions_team_idx on coach_sessions (team_id, expires_at) where ended_at is null;
create index if not exists coach_sessions_code_idx on coach_sessions (code_id);

alter table coach_sessions enable row level security;
revoke all on coach_sessions from anon, authenticated;

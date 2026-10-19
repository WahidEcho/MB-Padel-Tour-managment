-- 0034_court_codes.sql — court referee codes (Junior Finals, Cairo, 2 Nov 2026).
--
-- A referee event code (organization_codes, migration 0023) may now be limited to
-- one physical court. Courts are rows per tournament, so the physical court is named:
-- `court_name` ("Court 1"), compared case- and space-insensitively, within
--   • an event group (`event_group_id`): every tournament of the group, so one code
--     serves "Court 1" of the boys' and the girls' event alike; or
--   • one tournament (`tournament_id`), for an event without a group.
-- Exactly one of the two is set on a court code. The server (src/lib/auth/staff.ts,
-- src/lib/orgs/scope.ts) resolves the court ids on every request, so a match moved
-- to or from the court counts at once; nothing else in the database changes.
--
-- `code_sealed`: court codes are printed on the court's QR sheet and must be
-- reprintable, so their code is kept sealed (AES-256-GCM under a key derived from
-- EVENT_CODE_PEPPER, src/lib/orgs/codes.ts), as player codes are (0024). Other
-- event codes keep only their hash. Sign-in still looks a code up by its hash.
--
-- Idempotent. No new table; RLS stays on and nothing is granted to anon/authenticated.

alter table organization_codes
  add column if not exists event_group_id uuid references event_groups(id) on delete cascade;
alter table organization_codes
  add column if not exists court_name text;
alter table organization_codes
  add column if not exists code_sealed text;

alter table organization_codes drop constraint if exists organization_codes_court_scope;
alter table organization_codes add constraint organization_codes_court_scope check (
  (court_name is null and event_group_id is null)
  or (
    court_name is not null
    and role = 'referee'
    and char_length(btrim(court_name)) between 1 and 60
    and ((tournament_id is null) <> (event_group_id is null))
  )
);

alter table organization_codes drop constraint if exists organization_codes_sealed_shape;
alter table organization_codes add constraint organization_codes_sealed_shape check (
  code_sealed is null or (char_length(code_sealed) <= 200 and code_sealed like 'v1.%')
);

create index if not exists organization_codes_court_idx
  on organization_codes (organization_id, event_group_id, tournament_id)
  where court_name is not null;

-- A code's tournament, and now its event group, must be its own organisation's.
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
  return new;
end;
$$;
drop trigger if exists organization_codes_same_org on organization_codes;
create trigger organization_codes_same_org
  before insert or update of tournament_id, event_group_id, organization_id on organization_codes
  for each row execute function organization_codes_same_org();

alter table organization_codes enable row level security;
revoke all on organization_codes from anon, authenticated;

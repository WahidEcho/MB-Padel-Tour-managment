-- 0039_venue_map.sql — the 3D venue map and in-app navigation (Junior Finals,
-- Smash Sporting Club, Cairo). Docs: docs/venue-map.md. Pure logic: src/lib/venue/.
--
-- venue_maps: one venue per event group (both events of the Junior Finals share
-- the club) or per tournament without a group. `doc` is the venue document
-- (src/lib/venue/types.ts VenueDoc, schema 1): the geo anchor (lat/lng of the
-- plan's origin, rotation, scale), courts (rectangles in plan metres, linked to
-- the events' `courts` rows by name), buildings, the walkway graph (nodes +
-- edges), POIs (gates are POIs in category "entrance") and the survey fixes.
-- `underlay` is the editor's site plan: an uploaded image, or the vector layers
-- of an imported DXF / SVG plan. Neither is ever served as is: the public venue
-- (GET /api/mobile/v1/t/<slug>/venue) is an explicit projection of `doc`
-- (src/lib/venue/public.ts) and leaves the underlay and the survey fixes out.
--
-- Idempotent. RLS on, no policy, nothing granted to anon / authenticated (the
-- server's secret key bypasses RLS).

create table if not exists venue_maps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  event_group_id uuid references event_groups(id) on delete cascade,
  tournament_id uuid references tournaments(id) on delete cascade,
  name text not null default 'Venue' check (char_length(btrim(name)) between 1 and 120),
  doc jsonb not null default '{}'::jsonb check (pg_column_size(doc) <= 1048576),
  underlay jsonb check (underlay is null or pg_column_size(underlay) <= 6291456),
  -- Only a published venue reaches the public map, the app and the route API.
  published boolean not null default false,
  -- Bumped on every save: phones and the web page drop their cached copy.
  version integer not null default 1,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint venue_maps_one_owner check (num_nonnulls(event_group_id, tournament_id) = 1)
);
create unique index if not exists venue_maps_group_idx on venue_maps (event_group_id) where event_group_id is not null;
create unique index if not exists venue_maps_tournament_idx on venue_maps (tournament_id) where tournament_id is not null;
create index if not exists venue_maps_org_idx on venue_maps (organization_id);

-- The venue's organisation is its event group's (or tournament's): never another one.
create or replace function venue_maps_same_org() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.event_group_id is not null and not exists (
    select 1 from event_groups g where g.id = new.event_group_id and g.organization_id = new.organization_id
  ) then
    raise exception 'a venue map belongs to its event group''s organisation' using errcode = '23514';
  end if;
  if new.tournament_id is not null and not exists (
    select 1 from tournaments t where t.id = new.tournament_id and t.organization_id = new.organization_id
  ) then
    raise exception 'a venue map belongs to its tournament''s organisation' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists venue_maps_same_org on venue_maps;
create trigger venue_maps_same_org before insert or update on venue_maps
  for each row execute function venue_maps_same_org();

alter table venue_maps enable row level security;
revoke all on venue_maps from anon, authenticated;

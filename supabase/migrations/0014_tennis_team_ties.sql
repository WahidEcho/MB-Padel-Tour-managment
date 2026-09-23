-- Tennis team competitions (ITF Junior Davis Cup / Junior BJK Cup style).
--
-- A nation is a team row with a nation code, a captain and three or four players.
-- Two nations meet in a tie; a tie is three rubbers (No. 2 singles, No. 1
-- singles, doubles), and each rubber is an ordinary `matches` row, so the whole
-- scoring stack — referee phone, offline queue, events route, snapshots, venue
-- screens, voice — scores a rubber exactly as it scores any match.
--
-- Additive only: nothing existing changes meaning, and a tournament without
-- ties never touches the new table or columns.

alter table teams
  add column if not exists nation_code text,
  add column if not exists iso2 text,
  add column if not exists captain_name text;

create table if not exists ties (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments(id) on delete cascade,
  -- 'group' for the round robin; 'placement' for the draws that decide every place.
  stage text not null default 'group' check (stage in ('group', 'placement')),
  group_id uuid references groups(id) on delete cascade,
  -- Placement draws: which block of places this tie belongs to, e.g. 1-8, 9-16.
  draw_from integer,
  draw_to integer,
  -- The places the tie itself is played for once it can only decide two of them
  -- (a final is 1-2, a play-off 5-6). Null for earlier rounds.
  places_from integer,
  places_to integer,
  round_no integer not null default 1,
  round_name text,
  tie_order integer not null default 1,
  court_id uuid references courts(id) on delete set null,
  scheduled_time timestamptz,
  team_a_id uuid references teams(id) on delete set null,
  team_b_id uuid references teams(id) on delete set null,
  status text not null default 'scheduled' check (status in ('scheduled', 'live', 'completed')),
  rubbers_a integer not null default 0,
  rubbers_b integer not null default 0,
  winner_team_id uuid references teams(id) on delete set null,
  -- Where the winner and the loser go next; null when the tie decides places.
  winner_to_tie_id uuid references ties(id) on delete set null,
  winner_to_side text check (winner_to_side in ('A', 'B')),
  loser_to_tie_id uuid references ties(id) on delete set null,
  loser_to_side text check (loser_to_side in ('A', 'B')),
  -- Captains' nominations are frozen once locked; a later change is an audited override.
  lineup_locked_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ties_tournament_idx on ties (tournament_id);
create index if not exists ties_group_idx on ties (group_id);

alter table ties enable row level security;
drop policy if exists server_full_access on ties;
create policy server_full_access on ties for all to anon, authenticated using (true) with check (true);

alter table matches
  add column if not exists tie_id uuid references ties(id) on delete cascade,
  add column if not exists rubber_no integer,
  add column if not exists rubber_type text check (rubber_type in ('S1', 'S2', 'D')),
  -- Who plays this rubber for each side, from the captains' nominations.
  add column if not exists team_a_player_ids uuid[],
  add column if not exists team_b_player_ids uuid[];
create index if not exists matches_tie_idx on matches (tie_id);

alter table standings_snapshots
  add column if not exists rubbers_won integer default 0,
  add column if not exists rubbers_lost integer default 0;

-- Move Score mobile app, Phase 1.
--
-- Additive only: new columns default to "nothing set" and every new table is
-- empty, so the web app behaves exactly as before. Each new table gets the same
-- server_full_access policy as every other table today, because the server still
-- connects with the anon key; supabase/gate/close_open_access.sql removes all of
-- them together once SUPABASE_KEY is the secret key.

-- Where and when a tournament is played, and the event it belongs to. Two
-- tournaments played side by side (the boys' and girls' Junior Finals) share one
-- event group, which is what the app shows as a single event.
create table if not exists event_groups (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  subtitle text,
  venue_name text,
  city text,
  country_code text,
  timezone text not null default 'Africa/Cairo',
  starts_on date,
  ends_on date,
  artwork_url text,
  -- Lower is shown first on Discover; null is not featured.
  featured_rank integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table tournaments add column if not exists event_group_id uuid references event_groups(id) on delete set null;
alter table tournaments add column if not exists venue_name text;
alter table tournaments add column if not exists city text;
alter table tournaments add column if not exists country_code text;
alter table tournaments add column if not exists timezone text not null default 'Africa/Cairo';
alter table tournaments add column if not exists starts_on date;
alter table tournaments add column if not exists ends_on date;
-- The tournament's look inside the app: { mode, seedA, seedB, artworkUrl }.
alter table tournaments add column if not exists app_skin jsonb not null default '{}'::jsonb;
create index if not exists tournaments_event_group_idx on tournaments(event_group_id);

-- One row per setting. 'flags' holds the app's feature switches.
create table if not exists platform_settings (
  key text primary key,
  value_json jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);

create table if not exists announcements (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid references tournaments(id) on delete cascade,
  event_group_id uuid references event_groups(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  body text check (char_length(body) <= 600),
  -- 'major' is pushed to everyone following the event; 'info' only appears in the app.
  level text not null default 'info' check (level in ('major', 'info')),
  published_at timestamptz not null default now(),
  created_by_role text,
  created_at timestamptz not null default now()
);
create index if not exists announcements_tournament_idx on announcements(tournament_id, published_at desc);
create index if not exists announcements_group_idx on announcements(event_group_id, published_at desc);

-- A phone with the app installed. Guests are identified by installation only.
create table if not exists push_devices (
  id uuid primary key default gen_random_uuid(),
  installation_id text not null unique check (char_length(installation_id) between 16 and 80),
  user_id uuid,
  platform text not null check (platform in ('ios', 'android')),
  expo_push_token text unique,
  app_version text,
  tz text,
  locale text,
  -- Which alert kinds this phone wants: { scheduled, starting, live, finished, tie, major }.
  prefs jsonb not null default '{}'::jsonb,
  disabled_at timestamptz,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists push_devices_user_idx on push_devices(user_id);

-- Anything a person follows. Starred matches are follows of kind 'match'.
create table if not exists follows (
  id uuid primary key default gen_random_uuid(),
  owner_kind text not null check (owner_kind in ('install', 'user')),
  owner_id text not null,
  target_kind text not null check (target_kind in ('player', 'nation', 'tie', 'match', 'tournament', 'event_group')),
  -- players.id, ITF nation code, ties.id, matches.id, tournaments.id or event_groups.id
  target_key text not null check (char_length(target_key) between 2 and 64),
  tournament_id uuid references tournaments(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (owner_kind, owner_id, target_kind, target_key)
);
create index if not exists follows_target_idx on follows(target_kind, target_key);
create index if not exists follows_owner_idx on follows(owner_kind, owner_id);

-- The outbox: one row per thing worth telling people, written where it happens.
create table if not exists notification_events (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  tournament_id uuid references tournaments(id) on delete cascade,
  match_id uuid,
  tie_id uuid,
  payload jsonb not null default '{}'::jsonb,
  -- The same fact is only ever announced once.
  dedupe_key text not null unique,
  fire_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'cancelled', 'failed')),
  attempts integer not null default 0,
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notification_events_due_idx on notification_events(status, fire_at);

-- One alert per phone per event, however many reasons the phone had to receive it.
create table if not exists notification_deliveries (
  event_id uuid not null references notification_events(id) on delete cascade,
  device_id uuid not null references push_devices(id) on delete cascade,
  status text not null default 'queued',
  ticket_id text,
  error text,
  created_at timestamptz not null default now(),
  primary key (event_id, device_id)
);

-- Signed-in users (Apple / Google through Supabase Auth). No personal data beyond
-- the display name the provider gives; the age check stores only that it passed.
create table if not exists app_users (
  auth_user_id uuid primary key,
  display_name text,
  provider text check (provider in ('apple', 'google')),
  age_confirmed_at timestamptz,
  -- Apple's refresh token, encrypted, kept only to revoke it on account deletion.
  apple_refresh_token_enc text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The collectible event pass, its day stamps and nation pins.
create table if not exists event_passes (
  id uuid primary key default gen_random_uuid(),
  event_group_id uuid not null references event_groups(id) on delete cascade,
  owner_kind text not null check (owner_kind in ('install', 'user')),
  owner_id text not null,
  serial integer not null,
  edition text not null default 'spectator' check (edition in ('spectator', 'staff')),
  staff_role text,
  nation_code text,
  holder_name text check (char_length(holder_name) <= 40),
  onsite_unlocked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (event_group_id, owner_kind, owner_id),
  unique (event_group_id, serial)
);
create table if not exists pass_stamps (
  pass_id uuid not null references event_passes(id) on delete cascade,
  day date not null,
  created_at timestamptz not null default now(),
  primary key (pass_id, day)
);
create table if not exists pass_pins (
  pass_id uuid not null references event_passes(id) on delete cascade,
  pin_code text not null,
  source text not null default 'follow' check (source in ('follow', 'onsite')),
  created_at timestamptz not null default now(),
  primary key (pass_id, pin_code)
);

-- Tap-to-cheer totals per tie and nation. Counts only; no text, nothing to moderate.
create table if not exists tie_cheers (
  tie_id uuid not null references ties(id) on delete cascade,
  nation_code text not null,
  count bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (tie_id, nation_code)
);

-- iPhone lock-screen live scores: one push token per activity.
create table if not exists live_activity_tokens (
  id uuid primary key default gen_random_uuid(),
  installation_id text not null,
  match_id uuid not null references matches(id) on delete cascade,
  push_token text not null unique,
  created_at timestamptz not null default now(),
  ended_at timestamptz
);
create index if not exists live_activity_tokens_match_idx on live_activity_tokens(match_id) where ended_at is null;

-- Player claim (built for Phase 1, switched off by the 'player_claim' flag): an
-- organiser hands a player a one-time code; signing in and entering it links the
-- account to that player. Only the code's hash is stored.
create table if not exists player_claim_codes (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references players(id) on delete cascade,
  code_hash text not null unique,
  expires_at timestamptz not null default (now() + interval '30 days'),
  used_at timestamptz,
  used_by uuid,
  revoked_at timestamptz,
  created_by_role text,
  created_at timestamptz not null default now()
);
create table if not exists player_claims (
  user_id uuid not null,
  player_id uuid not null references players(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, player_id)
);

-- Same posture as every existing table until the gate closes (see header).
do $$
declare t text;
begin
  foreach t in array array['event_groups','platform_settings','announcements','push_devices','follows',
    'notification_events','notification_deliveries','app_users','event_passes','pass_stamps','pass_pins',
    'tie_cheers','live_activity_tokens','player_claim_codes','player_claims']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists server_full_access on %I', t);
    execute format('create policy server_full_access on %I for all to anon, authenticated using (true) with check (true)', t);
  end loop;
end $$;

insert into platform_settings (key, value_json)
values ('flags', '{"player_claim": false, "live_activity": false, "takeovers": true, "supporter_mode": false, "pins": false, "momentum": true, "wallet": false, "recap": false, "share_stories": true, "accounts": true}'::jsonb)
on conflict (key) do nothing;

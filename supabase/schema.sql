-- The public schema as it stands in the live project (dwyztzywuscljqklhqij),
-- read from the catalog on 2026-09-23, before migration 0014. The base schema
-- was applied through the Supabase MCP and never checked in; this is the record.
-- Used by scripts/localdb to stand up a local copy for tests.
create table audit_logs (
  id uuid default gen_random_uuid() not null,
  tournament_id uuid,
  actor_user_id text,
  actor_role text,
  action text not null,
  entity_type text,
  entity_id uuid,
  old_value jsonb,
  new_value jsonb,
  created_at timestamp with time zone default now()
);
create table bracket_slots (
  id uuid default gen_random_uuid() not null,
  bracket_id uuid not null,
  tournament_id uuid not null,
  round_name text not null,
  slot_order integer not null,
  match_id uuid,
  team_id uuid,
  source_type text,
  source_ref text,
  is_bye boolean default false,
  created_at timestamp with time zone default now()
);
create table brackets (
  id uuid default gen_random_uuid() not null,
  tournament_id uuid not null,
  bracket_name text default 'Main Bracket'::text,
  status text default 'draft'::text,
  approved_by text,
  approved_at timestamp with time zone,
  published_at timestamp with time zone,
  created_at timestamp with time zone default now(),
  tier text default 'cup'::text not null
);
create table check_in_logs (
  id uuid default gen_random_uuid() not null,
  tournament_id uuid not null,
  team_id uuid not null,
  old_status text,
  new_status text,
  actor_role text,
  created_at timestamp with time zone default now()
);
create table clone_logs (
  id uuid default gen_random_uuid() not null,
  source_tournament_id uuid,
  new_tournament_id uuid,
  options_json jsonb,
  actor_role text,
  created_at timestamp with time zone default now()
);
create table courts (
  id uuid default gen_random_uuid() not null,
  tournament_id uuid not null,
  court_name text not null,
  court_order integer default 1 not null,
  is_active boolean default true,
  created_at timestamp with time zone default now()
);
create table friendly_entries (
  id uuid default gen_random_uuid() not null,
  session_id uuid not null,
  player_profile_id uuid not null,
  source text default 'self'::text not null,
  approval text default 'pending'::text not null,
  preferred_partner_profile_id uuid,
  checked_in boolean default false not null,
  registered_at timestamp with time zone default now() not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  hidden boolean default false not null,
  rejected_at timestamp with time zone,
  rejection_note text
);
create table friendly_match_participants (
  match_id uuid not null,
  session_id uuid not null,
  pair_a_id uuid,
  pair_b_id uuid,
  team_a_player_one uuid not null,
  team_a_player_two uuid,
  team_b_player_one uuid not null,
  team_b_player_two uuid,
  round_number integer,
  created_at timestamp with time zone default now() not null
);
create table friendly_pairs (
  id uuid default gen_random_uuid() not null,
  session_id uuid not null,
  team_id uuid not null,
  player_one_profile_id uuid not null,
  player_two_profile_id uuid,
  label text,
  active_from_round integer default 1 not null,
  retired_after_round integer,
  created_at timestamp with time zone default now() not null
);
create table friendly_ranking_snapshots (
  id uuid default gen_random_uuid() not null,
  scope text not null,
  scope_id uuid,
  player_profile_id uuid not null,
  rank integer not null,
  points integer default 0 not null,
  base_points integer default 0 not null,
  fire_points integer default 0 not null,
  wins integer default 0 not null,
  losses integer default 0 not null,
  games_won integer default 0 not null,
  games_lost integer default 0 not null,
  game_diff integer default 0 not null,
  matches_played integer default 0 not null,
  active_streak integer default 0 not null,
  calculated_at timestamp with time zone default now() not null
);
create table friendly_sessions (
  id uuid default gen_random_uuid() not null,
  tournament_id uuid not null,
  season_id uuid,
  slug text not null,
  name text not null,
  status text default 'draft'::text not null,
  starts_at timestamp with time zone,
  duration_minutes integer,
  registration_deadline timestamp with time zone,
  expected_match_minutes integer default 30 not null,
  turnover_minutes integer default 5 not null,
  pairing_mode text default 'fixed'::text not null,
  cutoff_policy text default 'no_new_matches'::text not null,
  cutoff_extended_minutes integer default 0 not null,
  max_players integer,
  visibility text default 'public'::text not null,
  finalized_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  ranking_model text default 'win_points'::text not null,
  mexicano_pairing text default 'balanced_1_4'::text not null,
  draw_seed bigint,
  registration_mode text default 'individual'::text not null,
  scoring_mode text default 'point_by_point'::text not null
);
create table group_teams (
  id uuid default gen_random_uuid() not null,
  tournament_id uuid not null,
  group_id uuid not null,
  team_id uuid not null,
  "position" integer default 1,
  is_locked boolean default false,
  created_at timestamp with time zone default now()
);
create table groups (
  id uuid default gen_random_uuid() not null,
  tournament_id uuid not null,
  group_name text not null,
  group_order integer default 1 not null,
  status text default 'draft'::text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);
create table match_score_snapshots (
  id uuid default gen_random_uuid() not null,
  match_id uuid not null,
  tournament_id uuid not null,
  current_set_number integer default 1,
  team_a_point_label text default '0'::text,
  team_b_point_label text default '0'::text,
  team_a_games integer default 0,
  team_b_games integer default 0,
  team_a_sets integer default 0,
  team_b_sets integer default 0,
  is_tiebreak boolean default false,
  tiebreak_team_a_points integer default 0,
  tiebreak_team_b_points integer default 0,
  serving_team_id uuid,
  last_event_number integer default 0,
  completed_sets jsonb default '[]'::jsonb,
  snapshot_json jsonb,
  updated_at timestamp with time zone default now(),
  last_event_type text,
  last_event_team_id uuid,
  last_undo_event_number integer default 0 not null
);
create table matches (
  id uuid default gen_random_uuid() not null,
  tournament_id uuid not null,
  stage text default 'group'::text not null,
  group_id uuid,
  round_name text,
  match_order integer default 1,
  court_id uuid,
  scheduled_time timestamp with time zone,
  team_a_id uuid,
  team_b_id uuid,
  status text default 'scheduled'::text,
  serving_team_id uuid,
  winner_team_id uuid,
  active_scoring_device_id text,
  is_pending_sync boolean default false,
  started_at timestamp with time zone,
  ended_at timestamp with time zone,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  scoring_mode_override text,
  bracket_id uuid
);
create table page_presence (
  page_key text not null,
  visitor_id text not null,
  last_seen timestamp with time zone default now() not null
);
create table player_consents (
  id uuid default gen_random_uuid() not null,
  player_profile_id uuid not null,
  channel text not null,
  granted boolean default false not null,
  granted_at timestamp with time zone,
  revoked_at timestamp with time zone,
  source text default 'registration'::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table player_profile_categories (
  player_profile_id uuid not null,
  ranking_category_id uuid not null
);
create table player_profiles (
  id uuid default gen_random_uuid() not null,
  public_name text not null,
  mobile_normalized text,
  approval_status text default 'pending'::text not null,
  active_streak integer default 0 not null,
  streak_last_ledger_id bigint,
  merged_into_profile_id uuid,
  auth_user_id uuid,
  claim_status text default 'unclaimed'::text not null,
  notes text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  email text,
  birth_year integer,
  skill_level text,
  gender text,
  photo_url text,
  portrait_url text,
  focal_x real default 0.5 not null,
  focal_y real default 0.35 not null
);
create table player_score_ledger (
  id bigint generated by default as identity not null,
  player_profile_id uuid not null,
  match_id uuid not null,
  source text default 'friendly'::text not null,
  session_id uuid,
  tournament_id uuid,
  season_id uuid,
  component text not null,
  points integer not null,
  status text default 'provisional'::text not null,
  created_at timestamp with time zone default now() not null
);
create table players (
  id uuid default gen_random_uuid() not null,
  tournament_id uuid not null,
  team_id uuid not null,
  player_order integer default 1 not null,
  full_name text not null,
  photo_url text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  player_profile_id uuid,
  portrait_url text,
  focal_x real default 0.5 not null,
  focal_y real default 0.35 not null
);
create table ranking_categories (
  id uuid default gen_random_uuid() not null,
  name text not null,
  description text,
  sort_order integer default 0 not null,
  created_at timestamp with time zone default now() not null
);
create table request_counters (
  bucket_key text not null,
  window_started_at timestamp with time zone default now() not null,
  count integer default 0 not null
);
create table score_events (
  id uuid default gen_random_uuid() not null,
  client_event_id text,
  tournament_id uuid not null,
  match_id uuid not null,
  event_number integer not null,
  event_type text not null,
  team_id uuid,
  previous_state_json jsonb,
  new_state_json jsonb,
  created_by text,
  created_by_role text,
  created_at_server timestamp with time zone default now(),
  created_at_client timestamp with time zone,
  sync_status text default 'synced'::text,
  undo_of_event_id uuid,
  note text
);
create table scoring_leases (
  id uuid default gen_random_uuid() not null,
  match_id uuid not null,
  tournament_id uuid not null,
  device_id text not null,
  device_label text,
  revision integer default 0 not null,
  acquired_at timestamp with time zone default now() not null,
  renewed_at timestamp with time zone default now() not null,
  expires_at timestamp with time zone not null,
  released_at timestamp with time zone,
  transfer_request jsonb
);
create table screen_settings (
  id uuid default gen_random_uuid() not null,
  tournament_id uuid not null,
  screen_key text default 'main'::text not null,
  display_mode text default 'leaderboard'::text not null,
  focus_court_id uuid,
  theme text default 'dark'::text not null,
  sponsor_rotation_seconds integer default 10,
  updated_at timestamp with time zone default now(),
  screen_name text,
  court_ids uuid[] default '{}'::uuid[] not null,
  focus_match_id uuid,
  bracket_tier text default 'both'::text not null,
  revision integer default 0 not null,
  break_started_at timestamp with time zone,
  break_ends_at timestamp with time zone,
  mute_animations boolean default false not null,
  ceremony_step integer default 0 not null,
  ceremony_step_at timestamp with time zone,
  entrance_replay jsonb
);
create table seasons (
  id uuid default gen_random_uuid() not null,
  name text not null,
  starts_on date,
  ends_on date,
  status text default 'active'::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table standings_snapshots (
  id uuid default gen_random_uuid() not null,
  tournament_id uuid not null,
  group_id uuid not null,
  team_id uuid not null,
  rank integer,
  played integer default 0,
  won integer default 0,
  lost integer default 0,
  points integer default 0,
  sets_won integer default 0,
  sets_lost integer default 0,
  set_diff integer default 0,
  games_won integer default 0,
  games_lost integer default 0,
  game_diff integer default 0,
  status text default 'pending'::text,
  manual_status_override boolean default false,
  calculated_at timestamp with time zone default now()
);
create table teams (
  id uuid default gen_random_uuid() not null,
  tournament_id uuid not null,
  team_name text not null,
  phone text,
  notes text,
  seed_number integer,
  check_in_status text default 'not_arrived'::text,
  team_status text default 'active'::text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);
create table tournaments (
  id uuid default gen_random_uuid() not null,
  name text not null,
  slug text not null,
  sport text default 'padel'::text,
  status text default 'draft'::text,
  is_demo boolean default false,
  cloned_from_tournament_id uuid,
  branding_config jsonb default '{}'::jsonb,
  scoring_config jsonb default '{"gamesToWinSet": 6, "walkoverScore": "6-0", "setsToWinMatch": 1, "tiebreakAtGames": 6, "tiebreakEnabled": true, "tiebreakWinByTwo": true, "tiebreakTargetPoints": 7}'::jsonb,
  format_config jsonb default '{"type": "group_knockout", "qualifyPerGroup": 2, "thirdPlaceMatch": true}'::jsonb,
  court_config jsonb default '{}'::jsonb,
  lower_third_text text default 'Move Beyond Tournament Management | Powered by Move Beyond'::text,
  public_access_enabled boolean default true,
  created_by text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  kind text default 'tournament'::text not null
);
alter table audit_logs add constraint audit_logs_pkey PRIMARY KEY (id);
alter table bracket_slots add constraint bracket_slots_pkey PRIMARY KEY (id);
alter table brackets add constraint brackets_pkey PRIMARY KEY (id);
alter table check_in_logs add constraint check_in_logs_pkey PRIMARY KEY (id);
alter table clone_logs add constraint clone_logs_pkey PRIMARY KEY (id);
alter table courts add constraint courts_pkey PRIMARY KEY (id);
alter table friendly_entries add constraint friendly_entries_pkey PRIMARY KEY (id);
alter table friendly_match_participants add constraint friendly_match_participants_pkey PRIMARY KEY (match_id);
alter table friendly_pairs add constraint friendly_pairs_pkey PRIMARY KEY (id);
alter table friendly_ranking_snapshots add constraint friendly_ranking_snapshots_pkey PRIMARY KEY (id);
alter table friendly_sessions add constraint friendly_sessions_pkey PRIMARY KEY (id);
alter table group_teams add constraint group_teams_pkey PRIMARY KEY (id);
alter table groups add constraint groups_pkey PRIMARY KEY (id);
alter table match_score_snapshots add constraint match_score_snapshots_pkey PRIMARY KEY (id);
alter table matches add constraint matches_pkey PRIMARY KEY (id);
alter table page_presence add constraint page_presence_pkey PRIMARY KEY (page_key, visitor_id);
alter table player_consents add constraint player_consents_pkey PRIMARY KEY (id);
alter table player_profile_categories add constraint player_profile_categories_pkey PRIMARY KEY (player_profile_id, ranking_category_id);
alter table player_profiles add constraint player_profiles_pkey PRIMARY KEY (id);
alter table player_score_ledger add constraint player_score_ledger_pkey PRIMARY KEY (id);
alter table players add constraint players_pkey PRIMARY KEY (id);
alter table ranking_categories add constraint ranking_categories_pkey PRIMARY KEY (id);
alter table request_counters add constraint request_counters_pkey PRIMARY KEY (bucket_key);
alter table score_events add constraint score_events_pkey PRIMARY KEY (id);
alter table scoring_leases add constraint scoring_leases_pkey PRIMARY KEY (id);
alter table screen_settings add constraint screen_settings_pkey PRIMARY KEY (id);
alter table seasons add constraint seasons_pkey PRIMARY KEY (id);
alter table standings_snapshots add constraint standings_snapshots_pkey PRIMARY KEY (id);
alter table teams add constraint teams_pkey PRIMARY KEY (id);
alter table tournaments add constraint tournaments_pkey PRIMARY KEY (id);
alter table friendly_entries add constraint friendly_entries_session_id_player_profile_id_key UNIQUE (session_id, player_profile_id);
alter table friendly_sessions add constraint friendly_sessions_tournament_id_key UNIQUE (tournament_id);
alter table friendly_sessions add constraint friendly_sessions_slug_key UNIQUE (slug);
alter table group_teams add constraint group_teams_group_id_team_id_key UNIQUE (group_id, team_id);
alter table match_score_snapshots add constraint match_score_snapshots_match_id_key UNIQUE (match_id);
alter table player_consents add constraint player_consents_player_profile_id_channel_key UNIQUE (player_profile_id, channel);
alter table player_profiles add constraint player_profiles_auth_user_id_key UNIQUE (auth_user_id);
alter table player_profiles add constraint player_profiles_mobile_normalized_key UNIQUE (mobile_normalized);
alter table player_score_ledger add constraint player_score_ledger_match_id_player_profile_id_component_key UNIQUE (match_id, player_profile_id, component);
alter table ranking_categories add constraint ranking_categories_name_key UNIQUE (name);
alter table score_events add constraint score_events_client_event_id_key UNIQUE (client_event_id);
alter table score_events add constraint score_events_match_id_event_number_key UNIQUE (match_id, event_number);
alter table scoring_leases add constraint scoring_leases_match_id_key UNIQUE (match_id);
alter table screen_settings add constraint screen_settings_tournament_id_screen_key_key UNIQUE (tournament_id, screen_key);
alter table standings_snapshots add constraint standings_snapshots_group_id_team_id_key UNIQUE (group_id, team_id);
alter table tournaments add constraint tournaments_slug_key UNIQUE (slug);
alter table brackets add constraint brackets_tier_check CHECK ((tier = ANY (ARRAY['cup'::text, 'plate'::text])));
alter table friendly_entries add constraint friendly_entries_source_check CHECK ((source = ANY (ARRAY['self'::text, 'admin'::text])));
alter table friendly_entries add constraint friendly_entries_approval_check CHECK ((approval = ANY (ARRAY['pending'::text, 'approved'::text, 'waitlisted'::text, 'rejected'::text, 'withdrawn'::text])));
alter table friendly_ranking_snapshots add constraint friendly_ranking_snapshots_scope_check CHECK ((scope = ANY (ARRAY['session'::text, 'season'::text, 'lifetime'::text])));
alter table friendly_sessions add constraint friendly_sessions_scoring_mode_check CHECK ((scoring_mode = ANY (ARRAY['point_by_point'::text, 'final_score'::text])));
alter table friendly_sessions add constraint friendly_sessions_cutoff_policy_check CHECK ((cutoff_policy = ANY (ARRAY['no_new_matches'::text, 'open'::text])));
alter table friendly_sessions add constraint friendly_sessions_mexicano_pairing_check CHECK ((mexicano_pairing = ANY (ARRAY['balanced_1_4'::text, 'semi_1_3'::text, 'top_heavy_1_2'::text])));
alter table friendly_sessions add constraint friendly_sessions_pairing_mode_check CHECK ((pairing_mode = ANY (ARRAY['fixed'::text, 'americano'::text, 'mexicano'::text])));
alter table friendly_sessions add constraint friendly_sessions_ranking_model_check CHECK ((ranking_model = ANY (ARRAY['win_points'::text, 'games_won'::text])));
alter table friendly_sessions add constraint friendly_sessions_registration_mode_check CHECK ((registration_mode = ANY (ARRAY['individual'::text, 'team'::text, 'either'::text])));
alter table friendly_sessions add constraint friendly_sessions_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'open'::text, 'scheduled'::text, 'live'::text, 'completed'::text, 'finalized'::text])));
alter table friendly_sessions add constraint friendly_sessions_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'unlisted'::text])));
alter table matches add constraint matches_scoring_mode_override_check CHECK (((scoring_mode_override IS NULL) OR (scoring_mode_override = ANY (ARRAY['point_by_point'::text, 'final_score'::text]))));
alter table page_presence add constraint page_presence_page_key_length CHECK ((char_length(page_key) <= 120));
alter table page_presence add constraint page_presence_visitor_id_length CHECK ((char_length(visitor_id) <= 40));
alter table player_consents add constraint player_consents_source_check CHECK ((source = ANY (ARRAY['registration'::text, 'admin'::text, 'player'::text])));
alter table player_consents add constraint player_consents_channel_check CHECK ((channel = ANY (ARRAY['whatsapp'::text, 'web_push'::text, 'email'::text])));
alter table player_profiles add constraint player_profiles_birth_year_check CHECK (((birth_year IS NULL) OR ((birth_year >= 1900) AND (birth_year <= 2100))));
alter table player_profiles add constraint player_profiles_focal_check CHECK ((((focal_x >= (0)::double precision) AND (focal_x <= (1)::double precision)) AND ((focal_y >= (0)::double precision) AND (focal_y <= (1)::double precision))));
alter table player_profiles add constraint player_profiles_gender_check CHECK (((gender IS NULL) OR (gender = ANY (ARRAY['male'::text, 'female'::text, 'other'::text]))));
alter table player_profiles add constraint player_profiles_claim_status_check CHECK ((claim_status = ANY (ARRAY['unclaimed'::text, 'claimed'::text])));
alter table player_profiles add constraint player_profiles_approval_status_check CHECK ((approval_status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'merged'::text])));
alter table player_score_ledger add constraint player_score_ledger_status_check CHECK ((status = ANY (ARRAY['provisional'::text, 'official'::text])));
alter table player_score_ledger add constraint player_score_ledger_source_check CHECK ((source = ANY (ARRAY['friendly'::text, 'tournament'::text])));
alter table player_score_ledger add constraint player_score_ledger_component_check CHECK ((component = ANY (ARRAY['base_win'::text, 'fire'::text, 'games'::text])));
alter table players add constraint players_focal_check CHECK ((((focal_x >= (0)::double precision) AND (focal_x <= (1)::double precision)) AND ((focal_y >= (0)::double precision) AND (focal_y <= (1)::double precision))));
alter table scoring_leases add constraint scoring_leases_device_id_length CHECK ((char_length(device_id) <= 80));
alter table scoring_leases add constraint scoring_leases_device_label_length CHECK (((device_label IS NULL) OR (char_length(device_label) <= 60)));
alter table screen_settings add constraint screen_settings_bracket_tier_check CHECK ((bracket_tier = ANY (ARRAY['cup'::text, 'plate'::text, 'both'::text])));
alter table screen_settings add constraint screen_settings_display_mode_check CHECK ((display_mode = ANY (ARRAY['live'::text, 'leaderboard'::text, 'bracket'::text, 'winner'::text, 'ceremony'::text, 'sponsors'::text, 'holding'::text, 'live_court'::text, 'all_live'::text])));
alter table seasons add constraint seasons_status_check CHECK ((status = ANY (ARRAY['upcoming'::text, 'active'::text, 'closed'::text])));
alter table tournaments add constraint tournaments_kind_check CHECK ((kind = ANY (ARRAY['tournament'::text, 'friendly_session'::text])));
alter table audit_logs add constraint audit_logs_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE;
alter table bracket_slots add constraint bracket_slots_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE;
alter table bracket_slots add constraint bracket_slots_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL;
alter table bracket_slots add constraint bracket_slots_match_id_fkey FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE SET NULL;
alter table bracket_slots add constraint bracket_slots_bracket_id_fkey FOREIGN KEY (bracket_id) REFERENCES brackets(id) ON DELETE CASCADE;
alter table brackets add constraint brackets_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE;
alter table check_in_logs add constraint check_in_logs_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE;
alter table check_in_logs add constraint check_in_logs_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE;
alter table clone_logs add constraint clone_logs_source_tournament_id_fkey FOREIGN KEY (source_tournament_id) REFERENCES tournaments(id) ON DELETE SET NULL;
alter table clone_logs add constraint clone_logs_new_tournament_id_fkey FOREIGN KEY (new_tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE;
alter table courts add constraint courts_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE;
alter table friendly_entries add constraint friendly_entries_session_id_fkey FOREIGN KEY (session_id) REFERENCES friendly_sessions(id) ON DELETE CASCADE;
alter table friendly_entries add constraint friendly_entries_player_profile_id_fkey FOREIGN KEY (player_profile_id) REFERENCES player_profiles(id) ON DELETE CASCADE;
alter table friendly_entries add constraint friendly_entries_preferred_partner_profile_id_fkey FOREIGN KEY (preferred_partner_profile_id) REFERENCES player_profiles(id);
alter table friendly_match_participants add constraint friendly_match_participants_team_a_player_one_fkey FOREIGN KEY (team_a_player_one) REFERENCES player_profiles(id);
alter table friendly_match_participants add constraint friendly_match_participants_team_a_player_two_fkey FOREIGN KEY (team_a_player_two) REFERENCES player_profiles(id);
alter table friendly_match_participants add constraint friendly_match_participants_team_b_player_one_fkey FOREIGN KEY (team_b_player_one) REFERENCES player_profiles(id);
alter table friendly_match_participants add constraint friendly_match_participants_team_b_player_two_fkey FOREIGN KEY (team_b_player_two) REFERENCES player_profiles(id);
alter table friendly_match_participants add constraint friendly_match_participants_match_id_fkey FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE;
alter table friendly_match_participants add constraint friendly_match_participants_pair_a_id_fkey FOREIGN KEY (pair_a_id) REFERENCES friendly_pairs(id);
alter table friendly_match_participants add constraint friendly_match_participants_pair_b_id_fkey FOREIGN KEY (pair_b_id) REFERENCES friendly_pairs(id);
alter table friendly_match_participants add constraint friendly_match_participants_session_id_fkey FOREIGN KEY (session_id) REFERENCES friendly_sessions(id) ON DELETE CASCADE;
alter table friendly_pairs add constraint friendly_pairs_player_two_profile_id_fkey FOREIGN KEY (player_two_profile_id) REFERENCES player_profiles(id);
alter table friendly_pairs add constraint friendly_pairs_session_id_fkey FOREIGN KEY (session_id) REFERENCES friendly_sessions(id) ON DELETE CASCADE;
alter table friendly_pairs add constraint friendly_pairs_player_one_profile_id_fkey FOREIGN KEY (player_one_profile_id) REFERENCES player_profiles(id);
alter table friendly_pairs add constraint friendly_pairs_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE;
alter table friendly_ranking_snapshots add constraint friendly_ranking_snapshots_player_profile_id_fkey FOREIGN KEY (player_profile_id) REFERENCES player_profiles(id) ON DELETE CASCADE;
alter table friendly_sessions add constraint friendly_sessions_season_id_fkey FOREIGN KEY (season_id) REFERENCES seasons(id);
alter table friendly_sessions add constraint friendly_sessions_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE;
alter table group_teams add constraint group_teams_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE;
alter table group_teams add constraint group_teams_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE;
alter table group_teams add constraint group_teams_group_id_fkey FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE;
alter table groups add constraint groups_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE;
alter table match_score_snapshots add constraint match_score_snapshots_match_id_fkey FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE;
alter table match_score_snapshots add constraint match_score_snapshots_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE;
alter table matches add constraint matches_serving_team_id_fkey FOREIGN KEY (serving_team_id) REFERENCES teams(id);
alter table matches add constraint matches_court_id_fkey FOREIGN KEY (court_id) REFERENCES courts(id) ON DELETE SET NULL;
alter table matches add constraint matches_group_id_fkey FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL;
alter table matches add constraint matches_bracket_id_fkey FOREIGN KEY (bracket_id) REFERENCES brackets(id) ON DELETE SET NULL;
alter table matches add constraint matches_winner_team_id_fkey FOREIGN KEY (winner_team_id) REFERENCES teams(id);
alter table matches add constraint matches_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE;
alter table matches add constraint matches_team_b_id_fkey FOREIGN KEY (team_b_id) REFERENCES teams(id) ON DELETE SET NULL;
alter table matches add constraint matches_team_a_id_fkey FOREIGN KEY (team_a_id) REFERENCES teams(id) ON DELETE SET NULL;
alter table player_consents add constraint player_consents_player_profile_id_fkey FOREIGN KEY (player_profile_id) REFERENCES player_profiles(id) ON DELETE CASCADE;
alter table player_profile_categories add constraint player_profile_categories_ranking_category_id_fkey FOREIGN KEY (ranking_category_id) REFERENCES ranking_categories(id) ON DELETE CASCADE;
alter table player_profile_categories add constraint player_profile_categories_player_profile_id_fkey FOREIGN KEY (player_profile_id) REFERENCES player_profiles(id) ON DELETE CASCADE;
alter table player_profiles add constraint player_profiles_merged_into_profile_id_fkey FOREIGN KEY (merged_into_profile_id) REFERENCES player_profiles(id);
alter table player_score_ledger add constraint player_score_ledger_match_id_fkey FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE;
alter table player_score_ledger add constraint player_score_ledger_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE;
alter table player_score_ledger add constraint player_score_ledger_session_id_fkey FOREIGN KEY (session_id) REFERENCES friendly_sessions(id) ON DELETE CASCADE;
alter table player_score_ledger add constraint player_score_ledger_season_id_fkey FOREIGN KEY (season_id) REFERENCES seasons(id);
alter table player_score_ledger add constraint player_score_ledger_player_profile_id_fkey FOREIGN KEY (player_profile_id) REFERENCES player_profiles(id) ON DELETE CASCADE;
alter table players add constraint players_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE;
alter table players add constraint players_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE;
alter table players add constraint players_player_profile_id_fkey FOREIGN KEY (player_profile_id) REFERENCES player_profiles(id);
alter table score_events add constraint score_events_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE;
alter table score_events add constraint score_events_undo_of_event_id_fkey FOREIGN KEY (undo_of_event_id) REFERENCES score_events(id);
alter table score_events add constraint score_events_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams(id);
alter table score_events add constraint score_events_match_id_fkey FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE;
alter table scoring_leases add constraint scoring_leases_match_id_fkey FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE;
alter table scoring_leases add constraint scoring_leases_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE;
alter table screen_settings add constraint screen_settings_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE;
alter table screen_settings add constraint screen_settings_focus_court_id_fkey FOREIGN KEY (focus_court_id) REFERENCES courts(id) ON DELETE SET NULL;
alter table screen_settings add constraint screen_settings_focus_match_id_fkey FOREIGN KEY (focus_match_id) REFERENCES matches(id) ON DELETE SET NULL;
alter table standings_snapshots add constraint standings_snapshots_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE;
alter table standings_snapshots add constraint standings_snapshots_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE;
alter table standings_snapshots add constraint standings_snapshots_group_id_fkey FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE;
alter table teams add constraint teams_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX uq_seasons_single_active ON public.seasons USING btree (status) WHERE (status = 'active'::text);
CREATE UNIQUE INDEX uq_friendly_pairs_team ON public.friendly_pairs USING btree (team_id);
CREATE UNIQUE INDEX uq_ranking_snapshot_scope ON public.friendly_ranking_snapshots USING btree (scope, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid), player_profile_id);
CREATE UNIQUE INDEX uq_brackets_tournament_tier ON public.brackets USING btree (tournament_id, tier);

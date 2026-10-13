-- 0028_registration
--
-- Registration and payment (plan Phase 9). Players register for a tournament or
-- a friendly session in Move Score (the app, signed in; or the public web form as
-- a guest); paid entries go through Move Tick (docs/move-tick-partner-api.md) or
-- are paid at the venue.
--
-- 1. registration_settings: one row per event (a tournament, or a friendly
--    session's hidden tournament row). Closed by default. entry_type individual|
--    team (team_size players per entry), approval_mode organiser|automatic
--    (default organiser: the owner has not decided yet), fee per player in minor
--    units (piastres; EGP only), payment free|online|venue|online_or_venue,
--    team_payer registrant|each_player (default registrant: the registering
--    player pays for the whole team), refund_fee_percent (default 0: a refund
--    gives everything back), capacity, closes_at. Online payment is only ever
--    offered for the Move Beyond organisation and only while Move Tick is
--    configured on the server; otherwise a fee is paid at the venue.
-- 2. registrations: one entry. The app account that registered (null for a web
--    guest or an organiser's entry), the people (registrant first; names and the
--    contact details typed on the form, private), status pending_approval|
--    awaiting_payment|confirmed|refused|cancelled|refunded, what is due online and
--    at the venue (minor units), and the entry it became (team / registrant's
--    player row / friendly entries).
-- 3. registration_payments: each Move Tick checkout session or payment at the
--    venue: amount and currency fixed by the server when the session was made
--    (never by a client), the Move Tick session id (unique), status
--    created|open|paid|failed|expired|refund_pending|refunded|needs_review,
--    test mode, refund amount, who recorded a venue payment.
-- 4. move_tick_events: every Move Tick webhook event id already applied, so a
--    replayed event changes nothing (the payment's status changes are
--    conditional as well: paid only from created/open).
-- 5. player_claims.archived_at: set 24 h after the event ended (ends_on's end of
--    day in the event's time zone, or its completion, whichever is later) by the
--    messaging cron. An archived claim keeps the history (My profile, results)
--    but no longer sends alerts, fills the widget or answers "I'm at court".
--    player_claims.proof gains 'registration' (the account's own entry, linked
--    when its registration was confirmed).
--
-- Security: every new table has row-level security on and NO policy (like 0023):
-- the server's secret key bypasses RLS; the anon and authenticated keys read
-- nothing (contact details, payment references, refunds). They are on the
-- never-reopen list in supabase/gate/reopen_open_access.sql.
--
-- Additive and idempotent: safe to run more than once.

create table if not exists registration_settings (
  tournament_id uuid primary key references tournaments(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  open boolean not null default false,
  entry_type text not null default 'team' check (entry_type in ('individual', 'team')),
  team_size integer not null default 2 check (team_size between 1 and 8),
  approval_mode text not null default 'organiser' check (approval_mode in ('organiser', 'automatic')),
  -- Per player, minor units (piastres).
  fee_amount integer not null default 0 check (fee_amount between 0 and 10000000),
  currency text not null default 'EGP' check (currency = 'EGP'),
  payment text not null default 'free' check (payment in ('free', 'online', 'venue', 'online_or_venue')),
  team_payer text not null default 'registrant' check (team_payer in ('registrant', 'each_player')),
  refund_fee_percent numeric(5, 2) not null default 0 check (refund_fee_percent between 0 and 20),
  capacity integer check (capacity is null or capacity between 1 and 2000),
  closes_at timestamptz,
  note text check (note is null or char_length(note) <= 1000),
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists registration_settings_org_idx on registration_settings (organization_id);

create table if not exists registrations (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  auth_user_id uuid,
  source text not null check (source in ('app', 'web', 'admin')),
  entry_type text not null check (entry_type in ('individual', 'team')),
  team_name text check (team_name is null or char_length(team_name) <= 80),
  -- [{ name, phone (E.164) | null, email | null }], the registrant first. Private.
  people jsonb not null default '[]'::jsonb,
  status text not null default 'pending_approval'
    check (status in ('pending_approval', 'awaiting_payment', 'confirmed', 'refused', 'cancelled', 'refunded')),
  payment_choice text not null default 'free' check (payment_choice in ('free', 'online', 'venue')),
  -- Minor units, fixed by the server from the settings when the entry was made.
  amount_online integer not null default 0 check (amount_online >= 0),
  amount_venue integer not null default 0 check (amount_venue >= 0),
  currency text not null default 'EGP' check (currency = 'EGP'),
  paid_at timestamptz,
  venue_paid_at timestamptz,
  venue_paid_by text,
  refund_requested_at timestamptz,
  refunded_at timestamptz,
  decided_at timestamptz,
  decided_by text,
  decision_note text check (decision_note is null or char_length(decision_note) <= 500),
  -- The entry it became once confirmed.
  team_id uuid references teams(id) on delete set null,
  player_id uuid references players(id) on delete set null,
  entry_ids jsonb not null default '[]'::jsonb,
  materialized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists registrations_tournament_idx on registrations (tournament_id, status, created_at);
create index if not exists registrations_org_idx on registrations (organization_id, created_at desc);
create index if not exists registrations_user_idx on registrations (auth_user_id, created_at desc) where auth_user_id is not null;
-- One live entry per account per event (a cancelled, refused or refunded one can be followed by a new one).
create unique index if not exists registrations_user_event_uq on registrations (tournament_id, auth_user_id)
  where auth_user_id is not null and status in ('pending_approval', 'awaiting_payment', 'confirmed');

create table if not exists registration_payments (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references registrations(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  method text not null check (method in ('online', 'venue')),
  provider text not null default 'move_tick' check (provider in ('move_tick', 'venue')),
  amount integer not null check (amount >= 0),
  currency text not null default 'EGP' check (currency = 'EGP'),
  status text not null default 'created'
    check (status in ('created', 'open', 'paid', 'failed', 'expired', 'refund_pending', 'refunded', 'needs_review')),
  session_id text unique check (session_id is null or char_length(session_id) <= 120),
  checkout_url text check (checkout_url is null or char_length(checkout_url) <= 2000),
  expires_at timestamptz,
  test_mode boolean not null default false,
  paid_at timestamptz,
  refund_amount integer check (refund_amount is null or refund_amount >= 0),
  refund_id text check (refund_id is null or char_length(refund_id) <= 120),
  refund_requested_by text,
  refunded_at timestamptz,
  review_reason text check (review_reason is null or char_length(review_reason) <= 300),
  last_event_id text,
  recorded_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists registration_payments_registration_idx on registration_payments (registration_id, created_at desc);
create index if not exists registration_payments_open_idx on registration_payments (status, created_at) where status in ('created', 'open');

create table if not exists move_tick_events (
  event_id text primary key check (char_length(event_id) between 1 and 120),
  type text not null,
  reference uuid,
  outcome text,
  received_at timestamptz not null default now()
);

-- A registration (and its payments) always belongs to its event's organisation.
-- The server sets it from the event; the database refuses anything else.
create or replace function registration_rows_same_org() returns trigger
language plpgsql
set search_path = public
as $$
declare
  want uuid;
begin
  if tg_table_name = 'registration_payments' then
    select organization_id into want from registrations where id = new.registration_id;
  else
    select organization_id into want from tournaments where id = new.tournament_id;
  end if;
  if want is null or want <> new.organization_id then
    raise exception 'a registration row must belong to its event''s organisation' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists registration_settings_same_org on registration_settings;
create trigger registration_settings_same_org
  before insert or update of tournament_id, organization_id on registration_settings
  for each row execute function registration_rows_same_org();
drop trigger if exists registrations_same_org on registrations;
create trigger registrations_same_org
  before insert or update of tournament_id, organization_id on registrations
  for each row execute function registration_rows_same_org();
drop trigger if exists registration_payments_same_org on registration_payments;
create trigger registration_payments_same_org
  before insert or update of registration_id, organization_id on registration_payments
  for each row execute function registration_rows_same_org();

-- ---------- player claims ----------
alter table player_claims add column if not exists archived_at timestamptz;
alter table player_claims drop constraint if exists player_claims_proof_check;
alter table player_claims add constraint player_claims_proof_check
  check (proof is null or proof in ('code', 'phone', 'email', 'offer', 'profile', 'registration'));
create index if not exists player_claims_live_idx on player_claims (user_id) where archived_at is null;

-- Row-level security: on, with no policy (see header).
alter table registration_settings enable row level security;
alter table registrations enable row level security;
alter table registration_payments enable row level security;
alter table move_tick_events enable row level security;
revoke all on registration_settings, registrations, registration_payments, move_tick_events from anon, authenticated;

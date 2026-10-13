-- 0024_player_identity
--
-- Phase 1: one person, one player profile, linked to their Move Score account.
-- See docs/player-identity.md.
--
-- 1. Player codes are looked up by a keyed hash. players.access_code_hash is
--    HMAC-SHA256(PLAYER_CODE_PEPPER, "mb-player-code:v1:" || code) in hex; the
--    pepper lives only in the server's environment, so the hash cannot be computed
--    here. Existing codes therefore stay in players.access_code until the server
--    hashes them: on first use (sign-in, claim, send), every minute in the
--    messaging cron, and all at once with scripts/ops/hash-player-codes.ts (the
--    owner runs it once after deploying). Hashing a row also stores the code sealed
--    (AES-256-GCM, key derived from the same pepper) in access_code_sealed, so the
--    organiser can still show and send it, and clears the plain column. The column
--    default (gen_player_access_code()) still gives every new player a code; the
--    same sweep hashes it within a minute.
-- 2. player_profiles.phone_verified_at: when the linked account proved the
--    profile's mobile with a one-time code. One account per profile: a unique
--    index on auth_user_id (never set before this phase, so nothing to tidy).
-- 3. player_claims.proof: how each row was linked (code, phone, email, offer,
--    profile), for the audit trail and the reset rules.
-- 4. phone_verifications: one-time codes sent to a phone (WhatsApp, or email after
--    the player said yes) to link the entries recorded with that phone. Only an
--    HMAC of the code is stored; 10 minutes, 5 attempts.
-- 5. player_link_offers: an organiser's "Link to app account" for one of its
--    players, bound to the account's email (only an HMAC of the address is
--    stored). The player confirms it in the app; nothing links before that.
--
-- Security: the new tables have row-level security on and no policy (the server's
-- secret key bypasses RLS; the anon and authenticated keys read nothing), and are
-- listed in supabase/gate/reopen_open_access.sql's private tables.
--
-- Additive and idempotent.

-- ---------- 1. hashed player codes ----------
alter table players add column if not exists access_code_hash text;
alter table players add column if not exists access_code_sealed text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'players_access_code_hash_format') then
    alter table players add constraint players_access_code_hash_format
      check (access_code_hash is null or access_code_hash ~ '^[0-9a-f]{64}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'players_access_code_sealed_length') then
    alter table players add constraint players_access_code_sealed_length
      check (access_code_sealed is null or char_length(access_code_sealed) <= 200);
  end if;
end $$;
create unique index if not exists players_access_code_hash_key on players (access_code_hash);

-- ---------- 2. profiles ----------
alter table player_profiles add column if not exists phone_verified_at timestamptz;
create unique index if not exists player_profiles_auth_user_key on player_profiles (auth_user_id) where auth_user_id is not null;

-- ---------- 3. how a claim was made ----------
alter table player_claims add column if not exists proof text;
alter table player_claims drop constraint if exists player_claims_proof_check;
alter table player_claims add constraint player_claims_proof_check
  check (proof is null or proof in ('code', 'phone', 'email', 'offer', 'profile'));

-- ---------- 4. phone one-time codes ----------
create table if not exists phone_verifications (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null,
  player_profile_id uuid references player_profiles(id) on delete set null,
  phone text not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  channel text not null default 'whatsapp' check (channel in ('whatsapp', 'email')),
  -- whether the provider accepted the last send (null: not sent yet)
  sent_ok boolean,
  email_sent_at timestamptz,
  expires_at timestamptz not null,
  attempts integer not null default 0 check (attempts >= 0),
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists phone_verifications_user_idx on phone_verifications (auth_user_id, created_at desc);
create index if not exists phone_verifications_phone_idx on phone_verifications (phone, created_at desc);

-- ---------- 5. organiser link offers ----------
create table if not exists player_link_offers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  player_profile_id uuid not null references player_profiles(id) on delete cascade,
  email_hash text not null check (email_hash ~ '^[0-9a-f]{64}$'),
  created_by text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  consumed_at timestamptz,
  consumed_by uuid,
  revoked_at timestamptz
);
create index if not exists player_link_offers_email_idx on player_link_offers (email_hash) where consumed_at is null and revoked_at is null;
create index if not exists player_link_offers_profile_idx on player_link_offers (player_profile_id);

-- ---------- security ----------
alter table phone_verifications enable row level security;
alter table player_link_offers enable row level security;
revoke all on phone_verifications, player_link_offers from anon, authenticated;

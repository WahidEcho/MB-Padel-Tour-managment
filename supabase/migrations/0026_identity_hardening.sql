-- 0026_identity_hardening
--
-- Security review of Phase 1 (player identity, 0024). Additive and idempotent; no
-- new table. See docs/player-identity.md.
--
-- 1. players.self_reported_phone: the number a linked player types in the app
--    ("Phone, only the organisers see it"). It used to overwrite players.phone,
--    which phone one-time codes and their email fallback look rows up by, so an
--    account could put someone else's number on its own row and then pose as the
--    owner of that number. players.phone is now written by organisers only (or
--    proven by a WhatsApp code); the player's own entry lives here and is never
--    used to find or link anyone. Values written into players.phone by the app
--    before this migration cannot be told apart from organisers' and stay where
--    they are: the email fallback no longer trusts a phone number on its own
--    (it links only rows recorded with BOTH that phone and the account's own
--    confirmed email), so they lend nothing.
-- 2. phone_verifications.email_hash: when the player asks for the code by email,
--    the code goes only to the account's own confirmed address (and only when an
--    organiser recorded that address with the phone); a keyed hash of it is kept
--    so the check links only rows recorded with that phone AND that address.
-- 3. player_profiles.owner_scope_org: set when an account came to speak for a
--    profile through one organisation's "Link to app account" offer. That
--    organisation vouched for the account, nobody else did: the profile's rows in
--    other organisations are not picked up for it (and its sessions elsewhere are
--    not shown) until a stronger proof (a WhatsApp code to the profile's own
--    mobile, or the profile's own email) lands on it. Cleared with the link.
--    No foreign key on purpose: a deleted organisation must never widen the scope.

-- ---------- 1. the player's own number ----------
alter table players add column if not exists self_reported_phone text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'players_self_reported_phone_format') then
    alter table players add constraint players_self_reported_phone_format
      check (self_reported_phone is null or self_reported_phone ~ '^\+[1-9][0-9]{7,14}$');
  end if;
end $$;

-- ---------- 2. the address an emailed code went to ----------
alter table phone_verifications add column if not exists email_hash text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'phone_verifications_email_hash_format') then
    alter table phone_verifications add constraint phone_verifications_email_hash_format
      check (email_hash is null or email_hash ~ '^[0-9a-f]{64}$');
  end if;
end $$;
-- Open verifications per phone (the start route refuses a crowd of them across accounts).
create index if not exists phone_verifications_open_idx on phone_verifications (phone, expires_at) where consumed_at is null;

-- ---------- 3. ownership that came through one organisation's offer ----------
alter table player_profiles add column if not exists owner_scope_org uuid;

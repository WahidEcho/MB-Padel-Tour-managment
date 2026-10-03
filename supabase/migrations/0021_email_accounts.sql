-- 0021_email_accounts
--
-- Move Score accounts beyond Apple and Google:
--
-- 1. app_users.provider also takes 'email' (email + password, confirmed by email)
--    and 'player_code' (a player signed in with the code the tournament sent: a
--    Supabase anonymous user until they add and confirm their email).
-- 2. app_users.registration_complete: false only for a player-code account that
--    has not confirmed an email yet. pending_email is the address waiting for
--    confirmation; pending_password_enc is the password they chose, sealed with
--    AES-256-GCM under AUTH_SECRET (src/lib/auth/users.ts sealToken). Supabase
--    does not let an anonymous user set a password before the email is confirmed,
--    so the server sets it at confirmation and clears this column.
-- 3. app_user_deletions: accounts deleted in the app whose sign-in identity could
--    not be removed from Supabase Auth (that needs the secret key). Staff purge
--    them once SUPABASE_KEY is the secret key; a person who signs in again before
--    then starts a fresh account and the row is removed.
--
-- Fully idempotent: safe to run more than once.

alter table app_users drop constraint if exists app_users_provider_check;
alter table app_users add constraint app_users_provider_check check (provider in ('apple', 'google', 'email', 'player_code'));

alter table app_users add column if not exists registration_complete boolean not null default true;
alter table app_users add column if not exists pending_email text;
alter table app_users add column if not exists pending_password_enc text;
alter table app_users add column if not exists pending_since timestamptz;

create table if not exists app_user_deletions (
  auth_user_id uuid primary key,
  provider text,
  deleted_at timestamptz not null default now(),
  -- true when the server could also delete the Supabase Auth user (secret key in use)
  identity_deleted boolean not null default false
);

-- Same access as every other app table until supabase/gate/close_open_access.sql runs.
alter table app_user_deletions enable row level security;
drop policy if exists server_full_access on app_user_deletions;
create policy server_full_access on app_user_deletions for all to anon, authenticated using (true) with check (true);

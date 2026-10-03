-- 0018_player_codes
--
-- Every player gets a private access code the organisers share with them
-- (WhatsApp, email). Entered in the Move Score app by a signed-in player, it
-- links their account to their player record: name, matches, phone, photo.
--
-- Replaces the one-time hashed codes of 0015 (player_claim_codes), which were
-- shown once and could not be shared again. That table is left in place, unused.
--
-- 1. players.access_code: 8 characters from 23456789ABCDEFGHJKMNPQRSTUVWXYZ,
--    unique, generated for every existing player and by default for every new
--    one (src/lib/players/accessCode.ts makes the same shape for resets).
-- 2. players.phone and players.email: the player's own contact, E.164 phone.
--    Filled by organisers on the admin Player codes page or by the player in the
--    app. (teams.phone stays the team contact.)
-- 3. player_claims: one account per player (unique player_id); via_player_id
--    records whose code made the link, so resetting that code also undoes the
--    rows it linked in other tournaments.
-- 4. The app's player_claim flag is switched on.
--
-- Fully idempotent: safe to run more than once.

-- ---------- 1. Codes ----------

create or replace function gen_player_access_code() returns text
language plpgsql volatile as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  bytes bytea;
  b int;
  i int;
  code text := '';
begin
  -- gen_random_uuid() is the strong random source every Postgres 13+ has.
  -- Bytes 6 and 8 carry the UUID version and variant bits, so they are skipped;
  -- values of 248 and up are skipped too, so every symbol is equally likely.
  while length(code) < 8 loop
    bytes := uuid_send(gen_random_uuid());
    for i in 0..15 loop
      continue when i = 6 or i = 8;
      b := get_byte(bytes, i);
      continue when b >= 248;
      code := code || substr(alphabet, (b % 31) + 1, 1);
      exit when length(code) = 8;
    end loop;
  end loop;
  return code;
end $$;

alter table players add column if not exists access_code text;
alter table players add column if not exists phone text;
alter table players add column if not exists email text;
alter table players alter column access_code set default gen_player_access_code();

update players set access_code = gen_player_access_code() where access_code is null;

create unique index if not exists players_access_code_key on players(access_code);
create index if not exists players_phone_idx on players(phone) where phone is not null;
create index if not exists players_email_idx on players(lower(email)) where email is not null;
create index if not exists players_profile_idx on players(player_profile_id) where player_profile_id is not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'players_access_code_format') then
    alter table players add constraint players_access_code_format
      check (access_code is null or access_code ~ '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'players_phone_format') then
    alter table players add constraint players_phone_format check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'players_email_length') then
    alter table players add constraint players_email_length check (email is null or char_length(email) <= 254);
  end if;
end $$;

-- ---------- 3. One account per player ----------

alter table player_claims add column if not exists via_player_id uuid references players(id) on delete cascade;

-- The claim flag was off, so there should be nothing to tidy; keep the earliest if there is.
delete from player_claims c
using player_claims d
where c.player_id = d.player_id and (c.created_at, c.user_id) > (d.created_at, d.user_id);

create unique index if not exists player_claims_player_key on player_claims(player_id);
create index if not exists player_claims_user_idx on player_claims(user_id);
create index if not exists player_claims_via_idx on player_claims(via_player_id) where via_player_id is not null;

-- ---------- 4. Switch the app's player codes on ----------

update platform_settings
set value_json = value_json || '{"player_claim": true}'::jsonb, updated_at = now()
where key = 'flags' and coalesce((value_json ->> 'player_claim')::boolean, false) = false;

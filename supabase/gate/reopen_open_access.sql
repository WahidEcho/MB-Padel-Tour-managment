-- Rollback for close_open_access.sql: restores the old open posture for the
-- tables that had it, and NEVER for the private tables below.
--
-- PRIVATE TABLES (kept in sync with the migrations by src/lib/gateSql.test.ts:
-- every table a migration from 0022 on creates must be listed here):
--   organizations, organization_members, organization_codes, platform_admins,
--   organization_players, organization_invites, phone_verifications,
--   player_link_offers, rls_canary,
--   leagues, league_divisions, league_members, league_fixtures, league_points,
--   match_calls, live_activity_start_tokens, live_activity_starts,
--   registration_settings, registrations, registration_payments, move_tick_events
-- They hold event-code hashes, member emails, platform admins, organisations'
-- private player notes, invite and one-time-code hashes and their status, league
-- invite-code hashes and the organisers' membership decisions, referee devices and
-- presence on court calls, phones' push-to-start tokens and installation ids, and
-- registrations (people's contact details, payment references, refunds).
-- The anon and authenticated keys must
-- never read or write them, rollback or not: they stay RLS-on with no policy and
-- no grant. (So after this rollback, with the anon key back in SUPABASE_KEY, staff
-- sign-in and everything organisation-scoped stop working: that needs the secret
-- key. The rollback exists for the public pages and TVs.)
do $$
declare
  t text;
  private_tables constant text[] := array[
    'organizations',
    'organization_members',
    'organization_codes',
    'platform_admins',
    'organization_players',
    'organization_invites',
    'phone_verifications',
    'player_link_offers',
    'rls_canary',
    'leagues',
    'league_divisions',
    'league_members',
    'league_fixtures',
    'league_points',
    'match_calls',
    'live_activity_start_tokens',
    'live_activity_starts',
    'registration_settings',
    'registrations',
    'registration_payments',
    'move_tick_events'
  ];
begin
  for t in select tablename from pg_tables where schemaname = 'public' and not (tablename = any (private_tables)) loop
    execute format('drop policy if exists server_full_access on %I', t);
    execute format('create policy server_full_access on %I for all to anon, authenticated using (true) with check (true)', t);
  end loop;

  execute 'grant all on all tables in schema public to anon, authenticated';
  execute 'grant all on all sequences in schema public to anon, authenticated';

  -- Re-revoke: the blanket grant above reached the private tables too.
  foreach t in array private_tables loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('alter table %I enable row level security', t);
      execute format('drop policy if exists server_full_access on %I', t);
      execute format('revoke all on %I from anon, authenticated', t);
    end if;
  end loop;
end $$;

create policy media_write on storage.objects for insert to anon, authenticated with check (bucket_id = 'media');
create policy media_update on storage.objects for update to anon, authenticated using (bucket_id = 'media');
create policy media_delete on storage.objects for delete to anon, authenticated using (bucket_id = 'media');

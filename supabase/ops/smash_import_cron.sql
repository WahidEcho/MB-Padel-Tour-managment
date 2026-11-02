-- Copies finished results from Smash Sporting Club's public scores feed into the two Cairo
-- events every 2 minutes (src/lib/smash/server.ts, route /api/internal/smash/import). Same
-- pattern and secret as messaging_cron.sql; apply once in the SQL editor, replacing <SITE>.
--
--   <SITE>  https://tour.mbeg.org
--
-- The route does nothing until the deployment has SMASH_IMPORT_ON=1 (Vercel env), and it stops
-- itself after 8 Nov 2026 21:00 Cairo anyway (SMASH_IMPORT_UNTIL, an ISO time, overrides that).
-- Never courts 13 and 14; never a rubber that already has a score; doubtful results (no tie-break
-- points, retirements, line-up differs…) are listed in the response for the desk, not entered.
--
-- Needs the vault secret 'movescore_cron_secret' (the CRON_SECRET env var in Vercel), created by
-- notification_cron.sql. If that was never applied, first run:
--   select vault.create_secret('<CRON_SECRET>', 'movescore_cron_secret');

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'movescore-smash-import',
  '*/2 * * * *',
  $$
  select net.http_post(
    url := '<SITE>/api/internal/smash/import',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'movescore_cron_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

-- What the last runs did (entered, desk, skipped): pg_net keeps the responses for a while.
--   select created, status_code, left(content::text, 2000)
--   from net._http_response order by created desc limit 5;
--
-- To stop it (after the event, or at once if anything looks wrong; unsetting SMASH_IMPORT_ON in
-- Vercel and redeploying also stops it):
--   select cron.unschedule('movescore-smash-import');

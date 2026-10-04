-- Sends queued announcement emails and WhatsApp messages every minute from the
-- database (the safety net behind the admin page's own progress loop, so a long
-- send finishes even when nobody keeps the page open). Same pattern and secret as
-- notification_cron.sql; apply once per project in the SQL editor after migration
-- 0020_messaging.sql, replacing <SITE>.
--
--   <SITE>  https://tour.mbeg.org   (or the staging domain)
--
-- Needs the vault secret 'movescore_cron_secret' created by notification_cron.sql
-- (the CRON_SECRET env var in Vercel). If that was never applied, first run:
--   select vault.create_secret('<CRON_SECRET>', 'movescore_cron_secret');

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'movescore-drain-messages',
  '* * * * *',
  $$
  select net.http_post(
    url := '<SITE>/api/internal/messages/drain',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'movescore_cron_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

-- An idle run costs one indexed query. To stop it:
--   select cron.unschedule('movescore-drain-messages');
--
-- To point an existing job at a new site address (e.g. after a domain move):
--   select cron.alter_job(jobid, command := replace(command, '<OLD SITE>', '<SITE>'))
--   from cron.job where jobname = 'movescore-drain-messages';

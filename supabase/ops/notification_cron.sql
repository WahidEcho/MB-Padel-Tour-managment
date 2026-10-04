-- Runs the alert sender every minute from the database (the free Vercel plan only
-- allows daily cron jobs). Apply once per project in the SQL editor, after
-- replacing the two placeholders. The secret is kept in Supabase Vault, not here.
--
--   <SITE>         https://tour.mbeg.org   (or the staging domain)
--   <CRON_SECRET>  the same value as the CRON_SECRET env var in Vercel

create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('<CRON_SECRET>', 'movescore_cron_secret');

select cron.schedule(
  'movescore-drain-notifications',
  '* * * * *',
  $$
  select net.http_post(
    url := '<SITE>/api/internal/notifications/drain',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'movescore_cron_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
  $$
);

-- Each run also returns stuck 'sending' alerts to the queue and checks Expo's
-- delivery receipts (needs migration 0017_notify_fixes.sql applied first).
--
-- To stop it: select cron.unschedule('movescore-drain-notifications');
--
-- To point an existing job at a new site address (e.g. after a domain move):
--   select cron.alter_job(jobid, command := replace(command, '<OLD SITE>', '<SITE>'))
--   from cron.job where jobname = 'movescore-drain-notifications';

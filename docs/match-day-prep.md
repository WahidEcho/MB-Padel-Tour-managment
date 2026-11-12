# Before / after a big match day (Supabase and cron)

Between events the live project runs small and slow to save money (wound down 9 Nov 2026, after the Cairo
junior finals). Before the next big event, scale it back up; after the event, scale it down again.

## Before the event (a day or two ahead, not on the morning)

1. **Compute size up.** Supabase → Project Settings → Infrastructure → Compute size
   (https://supabase.com/dashboard/project/dwyztzywuscljqklhqij/settings/infrastructure).
   Micro (60 connections) is the between-events size. The Cairo week (16 courts, TVs, app, live stream) ran on
   **XL** (240 connections). Pick by the event: XL for a Cairo-sized event, Small/Medium for a club night.
   The project restarts for a few minutes, so never change it during play.
2. **Pooler.** Database → Settings → Connection pooling: leave the pool size at the compute's default unless
   there is a reason (it was 15 on Micro).
3. **Drain jobs back to every minute** (SQL editor,
   https://supabase.com/dashboard/project/dwyztzywuscljqklhqij/sql/new). Between events they run every 5 min, so
   a call-to-court reminder or "match soon" alert could be up to 5 min late:

   ```sql
   select cron.alter_job(job_id := 1, schedule := '* * * * *'); -- movescore-drain-notifications
   select cron.alter_job(job_id := 2, schedule := '* * * * *'); -- movescore-drain-messages
   select jobid, jobname, schedule, active from cron.job order by jobid;
   ```
4. Check `https://tour.mbeg.org/api/health/db` once (one request, never a loop).

## After the event

1. Tournaments → status `completed`; Match day tab → "Switch match day off"; Live stream → video off.
2. Revoke the event's codes: Admin → Referees (remove the event's referees, incl. the master referee),
   Team coaches (revoke), court codes expire on their own.
3. Unschedule any event-only cron job (e.g. `select cron.unschedule('movescore-smash-import');`).
4. Drain jobs to every 5 min (same SQL as above with `'*/5 * * * *'`), and purge old cron logs:
   `delete from cron.job_run_details where end_time < now() - interval '7 days';`
5. Compute back to Micro.

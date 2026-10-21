-- 0042: master referees answer a call for assistance with Coming or Decline, and an
-- unanswered call is re-alerted every 30 s and escalated to the organiser after 2 min
-- (docs/referees.md § "Call for assistance"; pure rules src/lib/referees/rules.ts).
--
-- 1. assistance_responses: each master's own answer to a call (one row per call and
--    master: a later answer replaces the earlier one). "coming" is written only by the
--    master whose Coming won the call's compare-and-set; "declined" keeps the call open
--    for the others and stops their reminders.
-- 2. assistance_calls: when the last push went out, how many 30-second reminder windows
--    have been claimed (a compare-and-set on it means one reminder per window, whoever
--    reads the call first: the court phone, a master's desk or the scheduled drain), and
--    when the organiser was alerted (once).
--
-- Idempotent. RLS on for the new table, no policy, nothing granted to anon /
-- authenticated (the server's secret key bypasses RLS). Apply on the live project
-- before deploying a build that reads these columns.

create table if not exists assistance_responses (
  call_id uuid not null references assistance_calls(id) on delete cascade,
  referee_id uuid not null references referees(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  referee_name text not null check (char_length(btrim(referee_name)) between 1 and 80),
  answer text not null check (answer in ('coming', 'declined')),
  answered_at timestamptz not null default now(),
  primary key (call_id, referee_id)
);
create index if not exists assistance_responses_org_idx on assistance_responses (organization_id, answered_at desc);

alter table assistance_responses enable row level security;
revoke all on assistance_responses from anon, authenticated;

alter table assistance_calls add column if not exists last_alert_at timestamptz;
alter table assistance_calls add column if not exists reminders_sent integer not null default 0;
alter table assistance_calls add column if not exists escalated_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'assistance_calls_reminders_sent_range') then
    alter table assistance_calls add constraint assistance_calls_reminders_sent_range check (reminders_sent between 0 and 1000);
  end if;
end $$;

-- The scheduled drain's sweep: open calls only.
create index if not exists assistance_calls_open_idx on assistance_calls (requested_at) where status = 'open';

alter table assistance_calls enable row level security;
revoke all on assistance_calls from anon, authenticated;

-- Why the chair umpire calls the master referees (owner, 31 Oct 2026): two buttons, "Call Referee
-- for Rule" and "Call Referee for Medical" (src/lib/referees/rules.ts ASSISTANCE_REASONS). Null on
-- calls from Move Score 1.0.4 and older, which send no reason. Apply before deploying the build that
-- selects it (assistance.ts CALL_COLS). No policy, no grant (the table stays server-only).

alter table assistance_calls add column if not exists reason text;

do $$
begin
  alter table assistance_calls add constraint assistance_calls_reason_check
    check (reason is null or reason in ('rules', 'medical'));
exception when duplicate_object then null;
end $$;

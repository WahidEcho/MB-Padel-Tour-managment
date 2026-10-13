-- 0029_registration_hardening
--
-- Security review of Phase 9 (registration and payment, 0028). Apply after 0028.
--
-- 1. registrations.status gains 'unconfirmed': a web guest's entry until the
--    guest opens the link emailed to the address they typed. It holds no place,
--    is never approved, paid or messaged beyond that one email, and is cancelled
--    by the messaging cron after 24 hours.
-- 2. registrations.notify_email: the only address Move Score ever writes to about
--    an entry, and only a verified one (an app account's confirmed email, or a
--    guest's address once its link was opened). Unique per event among live
--    entries, so one verified address holds one entry per event (guests deduped).
-- 3. registrations.hold_until / hold_started_at: an approved entry waiting for its
--    online payment keeps its place for 24 hours from approval (a checkout made near
--    the end may stretch it by at most one hour, never further). Capacity counts
--    confirmed entries and unexpired holds only (never requests waiting for the
--    organiser), checked atomically by a trigger that locks the event's settings row
--    (works on the local stand-in too). A payment that arrives after the hold ran out
--    confirms only if a place is free then; otherwise it is held for a refund.
-- 4. registration_payments: at most one open online checkout per registration
--    (a partial unique index), and reconciled_at, which throttles asking Move
--    Tick about a payment to once per 30 seconds.
--
-- Additive and idempotent: safe to run more than once.

-- ---------- registrations ----------
alter table registrations drop constraint if exists registrations_status_check;
alter table registrations add constraint registrations_status_check
  check (status in ('unconfirmed', 'pending_approval', 'awaiting_payment', 'confirmed', 'refused', 'cancelled', 'refunded'));

alter table registrations add column if not exists notify_email text;
alter table registrations drop constraint if exists registrations_notify_email_check;
alter table registrations add constraint registrations_notify_email_check
  check (notify_email is null or (char_length(notify_email) <= 200 and notify_email = lower(notify_email)));
alter table registrations add column if not exists hold_until timestamptz;
alter table registrations add column if not exists hold_started_at timestamptz;

create unique index if not exists registrations_contact_event_uq on registrations (tournament_id, notify_email)
  where notify_email is not null and status in ('pending_approval', 'awaiting_payment', 'confirmed');
create index if not exists registrations_unconfirmed_idx on registrations (created_at) where status = 'unconfirmed';

-- Capacity: confirmed entries plus approved ones whose payment hold has not run
-- out. Checked whenever an entry starts to hold a place it did not hold a moment
-- before: inserted or moved into confirmed (also an awaiting entry whose hold ran
-- out before its payment arrived), or a hold taken.
create or replace function registration_capacity_guard() returns trigger
language plpgsql
set search_path = public
as $$
declare
  cap integer;
  taken integer;
  holds_now boolean;
  held_before boolean := false;
begin
  holds_now := new.status = 'confirmed' or (new.status = 'awaiting_payment' and new.hold_until is not null and new.hold_until > now());
  if not holds_now then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    held_before := old.status = 'confirmed' or (old.status = 'awaiting_payment' and old.hold_until is not null and old.hold_until > now());
    if held_before then
      return new;
    end if;
  end if;
  -- One writer per event at a time: the settings row is the event's lock.
  select capacity into cap from registration_settings where tournament_id = new.tournament_id for update;
  if cap is null then
    return new;
  end if;
  select count(*) into taken from registrations r
   where r.tournament_id = new.tournament_id
     and r.id <> new.id
     and (r.status = 'confirmed' or (r.status = 'awaiting_payment' and r.hold_until is not null and r.hold_until > now()));
  if taken >= cap then
    raise exception 'registration_full' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists registrations_capacity on registrations;
create trigger registrations_capacity
  before insert or update of status, hold_until on registrations
  for each row execute function registration_capacity_guard();

-- ---------- registration_payments ----------
alter table registration_payments add column if not exists reconciled_at timestamptz;

-- Before the one-open-checkout rule: older duplicates are closed (reconciliation
-- still asks Move Tick about expired checkouts, so a late payment is not lost).
update registration_payments p set status = 'expired', updated_at = now()
 where p.method = 'online' and p.status in ('created', 'open')
   and exists (
     select 1 from registration_payments q
      where q.registration_id = p.registration_id and q.method = 'online'
        and q.status in ('created', 'open') and q.created_at > p.created_at);

create unique index if not exists registration_payments_one_open_uq on registration_payments (registration_id)
  where method = 'online' and status in ('created', 'open');

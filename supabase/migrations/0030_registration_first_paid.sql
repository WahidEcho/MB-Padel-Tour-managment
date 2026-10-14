-- 0030_registration_first_paid
--
-- The owner's final registration decisions (DECISIONS.md § 8). Apply after 0028 and
-- 0029 (none of the three is on the live project yet).
--
-- 1. approval_mode 'on_payment' ("first paid, first in") is the new default and
--    replaces 'automatic' (stored rows are moved over). An entry waiting for its
--    online payment holds NO place; it is confirmed, with no organiser step, the
--    moment its full online amount is paid. 'organiser' stays as an option.
-- 2. entry_type 'both': the player picks a solo or a team entry. Each registration
--    is still one or the other (registrations.entry_type is unchanged).
-- 3. registrations.hold_kind: what kind of place hold an awaiting_payment entry has.
--    'checkout': opening a Move Tick checkout took a short hold (15 minutes, the
--    checkout's lifetime) while a place was free; it ends when the checkout is paid,
--    fails or expires. 'approval': organiser mode only, the 24-hour hold an approval
--    gives (unchanged from 0029).
-- 4. Capacity is counted in players: registration_settings.capacity is in entries of
--    the event's size (teams for team or both entry, players for individual entry),
--    so capacity × team size players fit (× 1 for individual entry). A team entry
--    fills team_size of them, a solo entry one: two solo players later paired fill
--    exactly one team's place. The trigger registration_capacity_guard (0029) is
--    replaced to count that way; it still takes the event's settings row FOR UPDATE
--    (one writer per event), counts confirmed entries and unexpired holds only, and
--    raises 'registration_full'. A payment that lands when the event is full is not
--    confirmed: the server flags it needs_review for a full refund.
-- 5. refund_fee_percent is no longer read (refunds are always 100 %: Move Beyond
--    absorbs the card fee); the column stays, set to 0.
--
-- Additive and idempotent: safe to run more than once.

-- ---------- registration_settings ----------
alter table registration_settings drop constraint if exists registration_settings_approval_mode_check;
update registration_settings set approval_mode = 'on_payment' where approval_mode = 'automatic';
alter table registration_settings add constraint registration_settings_approval_mode_check
  check (approval_mode in ('on_payment', 'organiser'));
alter table registration_settings alter column approval_mode set default 'on_payment';

alter table registration_settings drop constraint if exists registration_settings_entry_type_check;
alter table registration_settings add constraint registration_settings_entry_type_check
  check (entry_type in ('individual', 'team', 'both'));

update registration_settings set refund_fee_percent = 0 where refund_fee_percent <> 0;
comment on column registration_settings.refund_fee_percent is 'Not read since 0030: refunds are always 100 %.';

-- ---------- registrations ----------
alter table registrations add column if not exists hold_kind text;
alter table registrations drop constraint if exists registrations_hold_kind_check;
alter table registrations add constraint registrations_hold_kind_check
  check (hold_kind is null or hold_kind in ('checkout', 'approval'));
-- Holds made before 0030 were approval holds.
update registrations set hold_kind = 'approval' where hold_until is not null and hold_kind is null;

-- ---------- capacity, counted in players ----------
create or replace function registration_capacity_guard() returns trigger
language plpgsql
set search_path = public
as $$
declare
  cap integer;
  kind text;
  size integer;
  need integer;
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
  select capacity, entry_type, team_size into cap, kind, size from registration_settings where tournament_id = new.tournament_id for update;
  if cap is null then
    return new;
  end if;
  if kind = 'individual' then
    size := 1;
  end if;
  need := greatest(1, coalesce(jsonb_array_length(new.people), 1));
  select coalesce(sum(greatest(1, coalesce(jsonb_array_length(r.people), 1))), 0) into taken from registrations r
   where r.tournament_id = new.tournament_id
     and r.id <> new.id
     and (r.status = 'confirmed' or (r.status = 'awaiting_payment' and r.hold_until is not null and r.hold_until > now()));
  if taken + need > cap * greatest(1, coalesce(size, 1)) then
    raise exception 'registration_full' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists registrations_capacity on registrations;
create trigger registrations_capacity
  before insert or update of status, hold_until on registrations
  for each row execute function registration_capacity_guard();

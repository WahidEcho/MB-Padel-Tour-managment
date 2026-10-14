-- 0033_payment_provider.sql — registration payments directly through XPay
-- (docs/xpay-direct.md; DECISIONS.md § 8). Apply after 0028–0030.
--
-- 1. registration_payments.provider may be 'xpay' (besides 'move_tick' and 'venue').
--    The old inline check is found by its definition, not by a guessed name.
-- 2. registration_payments.intent_id: the provider's payment intent (XPay refunds
--    name the intent, not the checkout session). Null until the payment is taken.
-- 3. move_tick_events (every applied webhook event id, so a replay changes nothing)
--    also records XPay's events: a provider column. XPay event ids are stored as
--    'xpay:<id>', so the primary key never mixes the two providers' ids.

do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.registration_payments'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%provider%'
  loop
    execute format('alter table public.registration_payments drop constraint %I', c.conname);
  end loop;
end $$;

alter table registration_payments
  add constraint registration_payments_provider_check check (provider in ('move_tick', 'xpay', 'venue'));

alter table registration_payments
  add column if not exists intent_id text check (intent_id is null or char_length(intent_id) <= 200);

alter table move_tick_events
  add column if not exists provider text not null default 'move_tick' check (provider in ('move_tick', 'xpay'));

-- XPay's own page may outlive Move Score's 15-minute hold (XPay's minimum lifetime is
-- 30 minutes): the housekeeping sweep closes open XPay checkouts past expires_at.
create index if not exists registration_payments_open_expiry_idx on registration_payments (provider, expires_at)
  where status in ('created', 'open');

-- Messaging: email (Resend) and WhatsApp (Cloud API) announcements and
-- transactional messages, with a delivery row per recipient per channel so the
-- console can show who each message reached and who it did not.
--
-- * message_announcements: what the admin sent (the console's "Announcements").
--   Named apart from `announcements`, which is the Move Score app's in-app feed
--   (0015); an announcement sent with the "App push" channel also writes there.
-- * message_deliveries: one row per recipient address per channel. Announcement
--   rows render their text at send time from the announcement plus `vars`;
--   transactional rows (announcement_id null) carry the rendered `payload`.
-- * whatsapp_contacts: the last time a number wrote to us (the 24-hour window for
--   free-form text) and whether it asked to stop.
-- * message_delivery_stats: per announcement, channel and status counts.
--
-- Additive and idempotent. Apply to the live project before deploying the code.

-- The player-codes work (0018) adds this too; repeated here so either order works.
alter table players add column if not exists access_code text;

create table if not exists message_announcements (
  id uuid primary key default gen_random_uuid(),
  -- 'announcement' (free text), 'access_codes', 'new_tournament'.
  kind text not null default 'announcement' check (kind in ('announcement', 'access_codes', 'new_tournament')),
  title text not null check (char_length(title) between 1 and 160),
  body text not null default '' check (char_length(body) <= 5000),
  -- Subset of {email, whatsapp, push}.
  channels text[] not null default '{}',
  -- { type: all_players | tournament | nation | app_users | list, tournamentId?, nationCode?, list? }
  audience jsonb not null default '{}'::jsonb,
  -- WhatsApp approved template: { name, language, params: [source...], headerImageUrl?, buttonParam? }
  whatsapp_template jsonb,
  -- Optional email call to action: { label, url }.
  cta jsonb,
  tournament_id uuid references tournaments(id) on delete set null,
  status text not null default 'draft' check (status in ('draft', 'sending', 'sent', 'cancelled')),
  recipients_total integer not null default 0,
  -- What the push channel did: the outbox dedupe key, to read its delivery counts.
  push_dedupe_key text,
  created_by text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists message_announcements_created_idx on message_announcements(created_at desc);

create table if not exists message_deliveries (
  id uuid primary key default gen_random_uuid(),
  announcement_id uuid references message_announcements(id) on delete cascade,
  channel text not null check (channel in ('email', 'whatsapp')),
  -- What the message is: 'announcement', 'test', or the transactional template name.
  purpose text not null default 'announcement',
  is_test boolean not null default false,
  -- Who: 'player_profile', 'player', 'list', 'adhoc'; the id is that row's id when there is one.
  recipient_kind text not null default 'adhoc',
  recipient_id text,
  recipient_name text,
  -- Email address, or E.164 phone (+201001234567). Null when the person has none.
  address text,
  -- Per-recipient merge values ({ name, code, tournament, ... }).
  vars jsonb not null default '{}'::jsonb,
  -- Transactional only: the rendered message ({ subject, html, text } or { template, ... }).
  payload jsonb,
  -- Same key, same message: a retried transactional call never sends twice.
  idempotency_key text,
  status text not null default 'queued'
    check (status in ('queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'bounced', 'complained', 'skipped')),
  provider_message_id text,
  error_code text,
  error_reason text,
  attempts integer not null default 0,
  claimed_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One message per address per channel per announcement (a person listed twice gets one).
create unique index if not exists message_deliveries_once_idx
  on message_deliveries(announcement_id, channel, address)
  where announcement_id is not null and address is not null and not is_test;
-- Not partial, so `on conflict (idempotency_key)` can use it (nulls never collide).
create unique index if not exists message_deliveries_idem_idx on message_deliveries(idempotency_key);
create unique index if not exists message_deliveries_provider_idx on message_deliveries(provider_message_id);
create index if not exists message_deliveries_announcement_idx on message_deliveries(announcement_id, status);
create index if not exists message_deliveries_queue_idx on message_deliveries(created_at) where status = 'queued';
create index if not exists message_deliveries_sending_idx on message_deliveries(claimed_at) where status = 'sending';
create index if not exists message_deliveries_recipient_idx on message_deliveries(recipient_kind, recipient_id);

create table if not exists whatsapp_contacts (
  phone text primary key,
  last_inbound_at timestamptz,
  opted_out_at timestamptz,
  updated_at timestamptz not null default now()
);

create or replace view message_delivery_stats with (security_invoker = true) as
  select announcement_id,
         channel,
         status,
         (error_code = '131026') as not_on_whatsapp,
         count(*)::int as n
    from message_deliveries
   where announcement_id is not null and not is_test
   group by announcement_id, channel, status, (error_code = '131026');

-- Same posture as every other table until supabase/gate/close_open_access.sql runs.
do $$
declare t text;
begin
  foreach t in array array['message_announcements', 'message_deliveries', 'whatsapp_contacts']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists server_full_access on %I', t);
    execute format('create policy server_full_access on %I for all to anon, authenticated using (true) with check (true)', t);
  end loop;
end $$;

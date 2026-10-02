-- Move Score alert sender fixes (src/lib/notify/drain.ts).
--
-- * notification_events.claimed_at: when a drain took the event (pending → sending).
--   A drain that dies mid-send (function timeout) leaves the event in 'sending';
--   the next drain returns it to 'pending' once it is older than five minutes.
-- * notification_deliveries.sent_at / receipt_checked_at: Expo hands back a ticket
--   per message and the delivery receipt about fifteen minutes later; the receipts
--   pass reads tickets sent between 15 minutes and a day ago that are not checked.
--
-- Idempotent. Apply to the live project BEFORE deploying the code that uses it.

alter table notification_events add column if not exists claimed_at timestamptz;
-- Events already stuck in 'sending' become recoverable five minutes from now.
update notification_events set claimed_at = now() where status = 'sending' and claimed_at is null;

alter table notification_deliveries add column if not exists sent_at timestamptz;
alter table notification_deliveries add column if not exists receipt_checked_at timestamptz;
-- Deliveries already sent before this migration are not receipt-checked (no sent_at).

create index if not exists notification_events_sending_idx on notification_events(claimed_at) where status = 'sending';
create index if not exists notification_deliveries_receipt_idx on notification_deliveries(sent_at)
  where status = 'sent' and receipt_checked_at is null;

-- ===================================================================
-- 0009_snapshot_last_event
--
-- Lets the venue screen tell a scored point from an undo.
--
-- The screen animates a point by comparing two looks at a court's snapshot a
-- couple of seconds apart. last_event_number alone cannot reveal an undo, because
-- score events are append-only: an UNDO is a NEW event with a HIGHER number than
-- the point it cancels, so the number only ever rises. The first design keyed undo
-- detection on that number decreasing — which can never happen — and would have
-- animated a correction forwards, for the wrong side.
--
-- last_undo_event_number is a watermark: the number of the most recent UNDO
-- applied to the match. It matters most for a referee's commonest correction —
-- undo the wrong side, then tap the right one — because both events land inside
-- one poll and the resulting score looks exactly like a fresh point. With the
-- watermark the screen sees that an undo happened in between and stays still.
--
-- last_event_type and last_event_team_id describe the final event in the batch,
-- for anything that wants to say what the most recent action was.
--
-- Fully idempotent: safe to run more than once.
-- ===================================================================

alter table match_score_snapshots add column if not exists last_event_type text;
alter table match_score_snapshots add column if not exists last_event_team_id uuid;
alter table match_score_snapshots add column if not exists last_undo_event_number int not null default 0;

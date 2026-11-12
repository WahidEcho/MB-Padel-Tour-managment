-- Players answer their call to court from their phones (owner, 12 Nov 2026): when the chair umpire
-- calls a match, each player's Move Score rings like a phone call and they answer "I'm coming" or
-- "Decline"; the chair umpire's call card shows each answer. One entry per player row id:
--   { "<player id>": { "answer": "coming" | "declined", "at": "<iso time>" } }
-- "I'm coming" is not "at court" (a_present_at / b_present_at stay the presence).
-- Read apart from the call's own columns (src/lib/matchday/server.ts readAnswers), so the server keeps
-- working before this runs; apply it before deploying anyway. No policy, no grant (server-only).

alter table match_calls add column if not exists player_answers jsonb not null default '{}'::jsonb;

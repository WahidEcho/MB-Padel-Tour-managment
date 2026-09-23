<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Move Beyond Tournament Management — agent notes

- Spec: `docs/move_beyond_tournament_management_spec.md`. README has the architecture summary.
- Supabase project id: `dwyztzywuscljqklhqij` (org `zigybnrxlgipryfgqvia`). Schema was applied
  via the Supabase MCP migration `init_tournament_schema`.
- All DB access is server-side through `src/lib/supabase.ts` (`db()`); the key is NOT public.
  Do not add `NEXT_PUBLIC_` Supabase env vars without first tightening RLS.
- Pure domain logic lives in `src/lib/` (scoring engine, round-robin, draws, standings,
  bracket) with vitest coverage — keep it framework-free. Server mutations live in
  `src/lib/ops.ts` and route/page `actions.ts` files.
- Offline referee scoring: Dexie queue in `src/lib/offline/db.ts`, sync endpoint
  `src/app/api/matches/[matchId]/events/route.ts` (ordered events, device lock, 409 conflicts).
- Verify with: `npm run lint`, `npx tsc --noEmit`, `npx vitest run`, `npm run build`, and the
  live-DB E2E: `npx tsx --env-file=.env.local scripts/smoke.ts` (creates + deletes its own data).
- No network route to the live project (cloud sessions): `npm run localdb` starts a local stand-in
  (PGlite + a PostgREST-compatible server on :54321, schema from `supabase/schema.sql` plus
  migrations ≥ 0014). Point `SUPABASE_URL=http://localhost:54321` at it and every E2E script runs.
  New migrations must also be applied to the live project (Supabase MCP `apply_migration`).
- Tennis team competitions (nations, ties of S2/S1/D rubbers, ITF ranking, placement draws for every
  place): `src/lib/tennis/`, admin pages `nations` and `ties`, gate `scripts/e2e/tennis-ties.ts`.
- Tennis court TVs (`src/components/tennis/`, scenes decided by `src/lib/tennis/tvScene.ts`): a tie-format
  tournament's live screen runs line-up → walk-on → live score → rubber won → tie score per court on its own.
  Flags are local SVGs in `public/flags/` (from `flag-icons`, MIT). Gate on the stand-in only:
  `npm run e2e:tennis-tv` (plays the demo's first tie; screenshots + video to `OUT`).

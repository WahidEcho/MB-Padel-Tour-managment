# Move Beyond Tournament Management

Live padel tournament operations platform: team entry, group draws, match scheduling, live
referee scoring (with offline support), leaderboards, knockout brackets, TV display screens,
clone tournament, and Excel export.

Built per `docs/move_beyond_tournament_management_spec.md` (V1 MVP).

## Stack

- **Next.js 16** (App Router, server components + server actions) · React 19 · Tailwind v4
- **Supabase** Postgres + Storage (project `move-beyond-tournaments`, eu-west-1)
- **Dexie (IndexedDB)** offline scoring queue · ordered event sync with device lock
- **ExcelJS** export · **@dnd-kit** drag/drop · **Vitest** unit tests

## Getting started

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # scoring engine + core lib unit tests (vitest)
npx tsx --env-file=.env.local scripts/smoke.ts   # full E2E simulation vs live DB
```

`.env.local` (see `.env.example`) needs:

| Variable | Purpose |
|---|---|
| `SUPABASE_URL`, `SUPABASE_KEY` | Database/storage access. **Server-side only** — never shipped to the browser. |
| `AUTH_SECRET` | HMAC secret for the session cookie. |
| `ADMIN_PASSWORD`, `MANAGER_PASSWORD`, `REFEREE_PASSWORD`, `OPERATOR_PASSWORD` | Shared access codes per role (spec §4.2). Change before the event. |

## Logins & roles

One login page (`/login`) — the access code determines the role:
**admin** and **manager** → admin console (`/admin`), **referee** → referee console (`/referee`),
**operator** → TV control (`/operator`). Public pages need no login.

## Event-day flow

1. **Admin** → New Tournament (courts 1–20) → Teams (manual or CSV import) → check-in on arrival.
2. **Groups** → create groups → 🎲 generate 3/5/10 draw options (locked teams stay put) →
   drag/drop adjustments → **Publish** (generates round-robin matches, BYE = rest round).
3. **Referee** (tablet/phone) opens a match → picks first server → giant score buttons,
   game-win confirmations, undo, pause, change server, force end / walkover / DQ / retirement.
   If the connection drops, scoring continues locally and syncs when back online
   (badge: Online / Offline / Syncing / Pending Sync / Sync Error). One scoring device per match.
4. **Leaderboard** updates automatically when matches finish (points → wins → head-to-head →
   set diff → game diff). Manual qualification override available.
5. **Bracket** → generate from standings → edit pairings (incl. BYE / lucky team) → approve →
   publish. Winners advance automatically; SF losers go to the third-place match.
6. **TV**: open `/t/<slug>/screen` on the display; the operator switches modes
   (leaderboard / live courts / bracket / winner / sponsors), theme, and sponsor rotation.
7. **Export Excel** from the tournament header; **Clone Tournament** to re-run the same setup.

## Public URLs

```
/t/<slug>              mobile overview (groups, live, upcoming)
/t/<slug>/leaderboard  standings
/t/<slug>/live         live scoreboards
/t/<slug>/bracket      knockout tree
/t/<slug>/winner       podium
/t/<slug>/screen       full-screen TV display (operator-controlled)
```

Public screens are read-only and poll every ~5–8s (spec §19.5 fallback strategy).

## Architecture notes

- **All DB access is server-side.** RLS is enabled with an "anon full access" policy because the
  anon key never leaves the server. Before exposing any key client-side (e.g. for Supabase
  Realtime), tighten RLS and move writes behind authenticated policies.
- **Scoring is event-sourced** (spec §29.3): every action is a `score_events` row with
  previous/new state; `match_score_snapshots` holds the current state; `audit_logs` records
  sensitive actions. The referee client owns live state (offline-first) and syncs ordered
  events; the server rejects out-of-sequence batches and non-controlling devices (409).
- **Theme** tokens live in `src/app/globals.css` (`:root` + `.theme-dark`) per spec §3.5 —
  swap colors there when the Move Beyond brand identity lands.

## Deploying (Vercel)

Set the env vars above in the Vercel project, deploy, done. The Supabase project is already
provisioned with the schema (`supabase/migrations` equivalent applied via MCP —
tables: tournaments, teams, players, courts, groups, group_teams, matches,
match_score_snapshots, score_events, standings_snapshots, brackets, bracket_slots,
check_in_logs, audit_logs, screen_settings, clone_logs + public `media` storage bucket).

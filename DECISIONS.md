# Locked decisions — Friendly Sessions & Player Rankings

Rules here are **settled**. Do not re-open, re-interpret, or "improve" them without
an explicit instruction from the product owner. If a rule turns out to be wrong,
change it *here first*, then change the code and tests to match.

Source of truth for behaviour: `src/lib/friendly/*` and `src/lib/friendly/friendly.test.ts`.

---

## 1. Scoring and fire streaks

### Match format — always the existing padel engine

**All friendly matches are scored with the existing padel engine (sets and games).**
There is no rally-to-N scoring, no second scoring engine, and **no timed rounds**.
Per-session defaults, all editable by the admin:

| Session type | Default format |
|---|---|
| Fixed partners | Best of 3 sets, or one set to 6 |
| Americano / Mexicano (rotation) | **One set to 6** (~30 min), so a 2-hour window fits 3–4 rounds |

Sets-to-win and games-to-win are per-session settings on the backing tournament's
`ScoringConfig` — the admin can change them freely.

### Ranking model — two, chosen per session

Only the **conversion from a finished match into ranking points** varies:

| Model | Rule |
|---|---|
| **`win_points`** (default) | **3** to each player on the winning pair, **0** to the losers |
| **`games_won`** | Each player banks **the games their own side won** — a 6-4 set gives the winners 6 each and the losers 4 each |

`games_won` is the Americano philosophy adapted to set scoring: losing narrowly
still banks points, which is what makes the Mexicano court ladder meaningful.
Conventional Americano/Mexicano elsewhere accumulates rally points to a 16/24/32
target; we deliberately use games instead, because our matches are set-scored.

**Fire streaks apply to BOTH models**, unchanged at +1 per streak win.

| Rule | Value |
|---|---|
| Base points, win (`win_points`) | **3** to each player on the winning pair |
| Base points, loss (`win_points`) | **0** |
| Games banked (`games_won`) | games won by that player's side |
| Fire point, win #1 of a streak | **+0** |
| Fire points, wins #2–#11 | **+1 each** (max **+10** per streak) |
| Fire points, win #12+ | **+0** until the streak breaks |
| Player session total | `3 × wins + fire points earned in that session` |
| Ranking order | total points → wins → game difference → games won |
| Ties after all four | **share the same rank** (1, 2, 2, 4) |

Games won/lost are recorded on every result but are **only** tiebreakers.

### Streak lifecycle

- A streak is a property of the **player**, not the session. It **carries across
  sessions and seasons** and breaks only on a played loss.
- A **played loss resets** the active streak to 0. **Banked fire points are never
  removed.** A later streak can bank another full 10.
- **Walkover WIN → streak FROZEN.** Pays the 3 base points, awards no fire, and
  leaves the counter untouched. A player on 4 wins who takes a walkover is still
  on 4; their next played win is #5 and earns a fire point.
  *This was the single most ambiguous rule in the original plan — it is now closed.*
- **Walkover LOSS (the absent player) → resets** the streak.
- **Void / cancelled → no effect** on points or streak.
- A **rest turn is not a result**: sitting out never touches the streak.
- **Retirement counts as a played result** for both sides (win / loss), not a walkover.

### Authoritative ordering — do not get this wrong

Fire history is replayed in ascending **`player_score_ledger.id`** (server-assigned
identity). **Never order fire history by a client timestamp.** Offline referee
devices sync late and their clocks drift, so client time would produce a different
streak history depending on sync order.

Three situations all funnel through the same replay (`rebuildFromResults`):
1. an admin corrects a historical result,
2. an offline device syncs a result late,
3. two duplicate profiles are merged.

A merge replays the **union** of both profiles' results in ledger order. It must not
sum the two profiles' banked totals — that double-counts.

---

## 2. Architecture

- **Backing-tournament pattern.** Every friendly session owns a hidden
  `tournaments` row with `kind = 'friendly_session'`. Pairs are `teams` rows;
  friendly matches are `matches` rows with `stage = 'friendly'`.
  *Why:* the entire scoring stack (referee screen, Dexie offline queue, events
  sync endpoint, device locks, snapshots, TV modes) keys off
  `match_id → tournament_id → teams`. This way all of it works **unmodified**.
  Verified: `matches.stage` is unconstrained `text`, so no DDL was needed there.
- **Tournament lists must filter `kind = 'tournament'`.** Backing rows must never
  surface in the admin tournament list, the public home page, or the referee /
  operator pickers.
- **Participant snapshots are written at match creation** into
  `friendly_match_participants` and are immutable except via the audited
  correction action. Re-versioning a pair never rewrites history.
- **Ledger idempotency** is enforced by `unique (match_id, player_profile_id,
  component)`. A retried offline sync can never double-award.
- **Ledger `source` discriminator** (`friendly` | `tournament`) exists from day one
  so tournament results can later feed the same Season/Lifetime rankings without a
  migration. **Only `friendly` is written today**, and ranking queries filter on it
  explicitly rather than assuming.

---

## 3. Sessions and scheduling

- Default session length **120 minutes**; default turnover **5 minutes**;
  default match length **30 min** (one set) or **60 min** (best of three).
- Default scoring is the existing `DEFAULT_SCORING_CONFIG` — one set to 6,
  advantage, tie-break at 6–6. Admins may switch to best-of-three.
  **Friendly sessions do not define their own scoring rules**; they reuse
  `ScoringConfig` on the backing tournament row, which keeps them multi-sport ready.
- Three pairing modes: **fixed** (partners fixed, opponents rotate),
  **americano** (partners rotate every round), **mexicano** (partners re-drawn each
  round from live standings).
- **Mexicano round 1 is a random draw**, seeded from `friendly_sessions.draw_seed`
  so a regenerated schedule reproduces the same draw instead of silently
  reshuffling an event that has already started.
- **Mexicano within-court pairing is per-session** (`mexicano_pairing`), because
  three mutually incompatible conventions ship in the wild and clubs migrating
  from another app expect their existing one:
  `balanced_1_4` (1+4 v 2+3 — equal rank sums, **default**), `semi_1_3` (1+3 v 2+4),
  `top_heavy_1_2` (1+2 v 3+4). One widely-cited source calls its own convention
  "universally accepted"; that claim is false — do not follow it.
- Mexicano makes **no coverage guarantee**: players are not promised to partner
  or face everyone. Do not imply otherwise in the UI.
- **No timed rounds.** They break the fairness of cross-court comparison, since a
  fast court banks more games than a slow one in the same wall-clock window.
- Scheduler invariants: no player on two courts in one round; matches per round
  never exceed courts; matches played and rest turns stay within one of each other
  where the player count allows.
- **Cutoff:** at the session cutoff no *new* match may start; matches already live
  are allowed to finish. Admins can explicitly extend.
  **An offline device that started a match late is accepted, not rejected** — the
  referee already let them play, so the data is real. It is flagged for review on
  the finalization screen instead. Data beats enforcement.
- Changing partners affects **unstarted matches only** and rebuilds just the
  remaining schedule. Active matches must be completed or voided first.

---

## 4. Identity and privacy

- Player identity is a **normalised mobile number**, with **admin approval** in
  place of SMS OTP for the first release.
- **Mobile numbers are never exposed publicly.** Public pages and API responses
  carry the public name and ranking data only.
- The public registration endpoint returns an **opaque** result. It must never
  reveal whether a mobile number already belongs to an existing player —
  duplicate handling is admin-only.
- Public registration is **rate limited** per IP and per session slug.
- **No player login in this release.** `player_profiles.auth_user_id` and
  `claim_status` exist purely as forward-compatibility columns and are read by
  nothing. Adding login later must not require a migration.
- A session with **no active season** is allowed: `season_id` is nullable,
  finalization warns, and such sessions count toward **Lifetime only**.

### Consent and messaging (Egypt PDPL)

- **`player_consents` holds per-player, per-channel consent** with grant/revoke
  timestamps and a capture source. Check it before any message is sent.
- Channels are **`whatsapp`, `web_push`, `email`**. **SMS is out of scope** — Egypt's
  NTRA curfew blocks marketing SMS on Fridays, Saturdays and 21:00–09:00, which is
  exactly when club padel runs.
- WhatsApp sending will use **the client's existing Meta-verified Business API
  account**; credentials are to be supplied. Do not build a separate onboarding
  or BSP integration path.
- When WhatsApp is wired up, send **utility-category templates**, not marketing —
  in Egypt the reported difference is $0.0036 vs $0.0644 per message for the same
  delivery. Keep template copy factual and tied to a booking the player made.
- PDPL compliance is reported as due **1 November 2026**. Treat that date and the
  licensing question as **unverified legal research** — confirm with Egyptian
  counsel; do not rely on it as settled law.

---

## 5. Scope prohibitions for this project

Not being built, regardless of how easy any of them looks mid-build:

payments / entry fees · SMS (dropped permanently) · actually sending WhatsApp or
push messages · player login or profile claiming · ELO or skill ratings · court
booking or memberships · native mobile apps · streaming overlays · rally-to-N
scoring · timed rounds · backfilling historical tournaments into the ledger.

The `player_consents` table is the deliberate exception: it is built now because
mobile numbers are already stored and retrofitting consent across an existing
player base is expensive. Recording consent is in scope; **sending is not**.

Two forward-compatibility *columns* are the deliberate exception
(`player_profiles.auth_user_id` / `claim_status`, `player_score_ledger.source`) —
they exist precisely so these stay out of scope without costing a future migration.

---

## 6. Migrations

- Numbered SQL files in `supabase/migrations/`, applied via the Supabase MCP
  connector. Applied so far: `0001_friendly_sessions.sql`,
  `0002_ranking_models_and_consent.sql`.
- **Every migration must be idempotent** (`if not exists` throughout) and safe to
  re-run.
- **Never edit a migration that has already been applied** — corrections go in a
  new numbered file.
- After applying, verify with a read-only query before writing code against the
  new shape.

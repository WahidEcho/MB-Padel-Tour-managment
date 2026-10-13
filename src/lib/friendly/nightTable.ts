/**
 * The night's table (Americano / Mexicano nights, plan Phase 8): the order of
 * play per court with "about 19:40" estimates, and the re-estimate of what is
 * left once matches start and finish.
 *
 * Matches start when their court is free (no timed rounds): a court plays its
 * matches in order, each as soon as the one before it is over and its four
 * players are off the other courts. `scheduler.ts estimateTimes()` plans that
 * up front; `reestimateNight()` replans the matches still waiting from what
 * actually happened (a match that ran long pushes its court back, one that
 * finished early pulls it forward), never placing a waiting match before now.
 *
 * `buildNightTable()` is the one view model every surface draws (the public
 * session page, the admin session page, the TV, the app's session screen and
 * league page). The owner's reference table layout is still to come: when it
 * arrives, `NIGHT_TABLE_LAYOUT` and the renderers that switch on `layout`
 * change, and nothing that stores or estimates the table does.
 *
 * Pure: shared with the Move Score app through move-score-app/src/core/index.ts.
 */
import { aboutTime } from "./scheduler";

/** How a table is laid out: one column per court (today's), or one block per round. */
export type NightTableLayout = "by_court" | "by_round";

/** The layout every surface draws. Waiting on the owner's reference layout; change it here. */
export const NIGHT_TABLE_LAYOUT: NightTableLayout = "by_court";

const MINUTE_MS = 60_000;
const DONE = new Set(["completed", "walkover", "disqualified", "retired", "cancelled"]);
const ON_COURT = new Set(["live", "paused", "pending_sync"]);

/** A match finished or called off: it no longer waits for its court. */
export const isNightMatchDone = (status: string) => DONE.has(status);

/* ---------------- re-estimating ---------------- */

export interface NightEstimateMatch {
  id: string;
  courtId: string | null;
  /** The match's place in the night (matches.match_order): rounds in order, courts in order within a round. */
  order: number;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  /** Player profile ids on court (four in doubles). */
  players: string[];
}

export interface ReestimateOptions {
  /** When the night starts (friendly_sessions.starts_at). Null: only what has started can anchor the estimates. */
  start: string | number | Date | null;
  matchMinutes: number;
  changeoverMinutes: number;
  /** Epoch ms. A waiting match is never estimated before now. */
  now: number;
}

function ms(v: string | number | Date | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const t = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * New estimated start times (ISO) for every match still waiting (scheduled or
 * called), from what has happened so far:
 *
 *  1. Every match that started or finished frees its court and its players at
 *     its real end (or, while it is on court, at its expected end but not before
 *     now), plus the changeover.
 *  2. The waiting matches, in the night's order, start at the latest of: the
 *     night's start, now, their court being free, and their players being free.
 *
 * Matches without a court are left out. Returns an empty map when the night has
 * no start time and nothing has started.
 */
export function reestimateNight(matches: NightEstimateMatch[], opts: ReestimateOptions): Map<string, string> {
  const out = new Map<string, string>();
  const play = Math.max(0, opts.matchMinutes) * MINUTE_MS;
  const gap = Math.max(0, opts.changeoverMinutes) * MINUTE_MS;
  const started = matches.map((m) => ms(m.startedAt)).filter((t): t is number => t !== null);
  const t0 = ms(opts.start) ?? (started.length ? Math.min(...started) : null);
  if (t0 === null) return out;

  const courtFree = new Map<string, number>();
  const playerFree = new Map<string, number>();
  const occupy = (m: NightEstimateMatch, end: number) => {
    const free = end + gap;
    if (m.courtId) courtFree.set(m.courtId, Math.max(courtFree.get(m.courtId) ?? t0, free));
    for (const p of m.players) playerFree.set(p, Math.max(playerFree.get(p) ?? t0, free));
  };

  // 1. What has happened.
  for (const m of matches) {
    const s = ms(m.startedAt);
    const e = ms(m.endedAt);
    if (DONE.has(m.status)) {
      // A match called off before it began never held its court.
      if (e === null && s === null) continue;
      occupy(m, e ?? (s as number) + play);
    } else if (ON_COURT.has(m.status)) {
      const from = s ?? opts.now;
      occupy(m, Math.max(from + play, opts.now));
    }
  }

  // 2. What is still to come, in the night's order.
  const waiting = matches
    .filter((m) => m.courtId && !DONE.has(m.status) && !ON_COURT.has(m.status))
    .sort((a, b) => a.order - b.order);
  for (const m of waiting) {
    const at = Math.max(
      t0,
      opts.now,
      courtFree.get(m.courtId!) ?? t0,
      ...m.players.map((p) => playerFree.get(p) ?? t0),
    );
    out.set(m.id, new Date(at).toISOString());
    occupy(m, at + play);
  }
  return out;
}

/* ---------------- the table every surface draws ---------------- */

export interface NightTableMatch {
  id: string;
  courtId: string | null;
  order: number;
  round: string | null;
  status: string;
  /** The estimate (matches.scheduled_time) while waiting. */
  scheduledTime: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** Side labels as the surface may show them (team names: "Ali & Omar"). */
  a: string | null;
  b: string | null;
  /** Which side won, once finished. */
  winner?: "A" | "B" | null;
}

export type NightEntryState = "waiting" | "called" | "live" | "finished" | "cancelled";

export interface NightTableEntry {
  matchId: string;
  /** 1-based place in its court's order of play. */
  position: number;
  round: string | null;
  state: NightEntryState;
  /** The estimate while waiting, the real start once on court, the end once finished. */
  at: string | null;
  /** "about 19:40", "On court", "Finished", "Cancelled", or "Time to come". */
  label: string;
  a: string;
  b: string;
  winner: "A" | "B" | null;
}

export interface NightTableCourt {
  courtId: string;
  name: string;
  entries: NightTableEntry[];
  /** The next waiting match's estimate on this court, if any. */
  nextAt: string | null;
}

export interface NightTableRound {
  round: string;
  entries: (NightTableEntry & { court: string })[];
}

export interface NightTable {
  layout: NightTableLayout;
  courts: NightTableCourt[];
  rounds: NightTableRound[];
  matches: number;
  finished: number;
  live: number;
}

export interface NightTableOptions {
  timeZone?: string;
  roundToMinutes?: number;
  layout?: NightTableLayout;
}

function stateOf(status: string): NightEntryState {
  if (status === "cancelled") return "cancelled";
  if (DONE.has(status)) return "finished";
  if (ON_COURT.has(status)) return "live";
  if (status === "ready") return "called";
  return "waiting";
}

const LABELS: Record<Exclude<NightEntryState, "waiting" | "called">, string> = {
  live: "On court",
  finished: "Finished",
  cancelled: "Cancelled",
};

/**
 * The night's table: per court, its matches in order of play with their
 * position and label; the same entries grouped by round. Courts keep their
 * own order; a match without a court sits under "Court to come".
 */
export function buildNightTable(
  courts: { id: string; name: string; order?: number }[],
  matches: NightTableMatch[],
  opts: NightTableOptions = {},
): NightTable {
  const tz = opts.timeZone || "Africa/Cairo";
  const step = opts.roundToMinutes ?? 5;
  const sortedCourts = [...courts].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const known = new Set(sortedCourts.map((c) => c.id));
  const lists = new Map<string, NightTableMatch[]>();
  for (const m of [...matches].sort((a, b) => a.order - b.order)) {
    const key = m.courtId && known.has(m.courtId) ? m.courtId : "";
    lists.set(key, [...(lists.get(key) ?? []), m]);
  }
  const columns = [...sortedCourts.map((c) => ({ id: c.id, name: c.name })), ...(lists.has("") ? [{ id: "", name: "Court to come" }] : [])];

  const entry = (m: NightTableMatch, position: number): NightTableEntry => {
    const state = stateOf(m.status);
    const at = state === "finished" ? (m.endedAt ?? m.startedAt) : state === "live" ? m.startedAt : state === "cancelled" ? null : m.scheduledTime;
    const t = ms(at);
    const label = state === "waiting" || state === "called" ? (t !== null ? aboutTime(t, tz, step) : "Time to come") : LABELS[state];
    return { matchId: m.id, position, round: m.round, state, at: at ?? null, label, a: m.a ?? "TBD", b: m.b ?? "TBD", winner: state === "finished" ? (m.winner ?? null) : null };
  };

  const tableCourts: NightTableCourt[] = columns
    .map((c) => {
      const entries = (lists.get(c.id) ?? []).map((m, i) => entry(m, i + 1));
      const next = entries.find((e) => e.state === "waiting" || e.state === "called");
      return { courtId: c.id, name: c.name, entries, nextAt: next?.at ?? null };
    })
    .filter((c) => c.entries.length > 0 || c.courtId !== "");

  const byRound = new Map<string, (NightTableEntry & { court: string; order: number })[]>();
  for (const c of tableCourts) {
    for (const e of c.entries) {
      const key = e.round ?? "—";
      const order = matches.find((m) => m.id === e.matchId)?.order ?? 0;
      byRound.set(key, [...(byRound.get(key) ?? []), { ...e, court: c.name, order }]);
    }
  }
  const rounds = [...byRound.entries()]
    .map(([round, list]) => ({ round, first: Math.min(...list.map((e) => e.order)), entries: list.sort((a, b) => a.order - b.order) }))
    .sort((a, b) => a.first - b.first)
    .map(({ round, entries }) => ({
      round,
      entries: entries.map((e) => ({ matchId: e.matchId, position: e.position, round: e.round, state: e.state, at: e.at, label: e.label, a: e.a, b: e.b, winner: e.winner, court: e.court })),
    }));

  const all = tableCourts.flatMap((c) => c.entries);
  return {
    layout: opts.layout ?? NIGHT_TABLE_LAYOUT,
    courts: tableCourts,
    rounds,
    matches: all.filter((e) => e.state !== "cancelled").length,
    finished: all.filter((e) => e.state === "finished").length,
    live: all.filter((e) => e.state === "live").length,
  };
}

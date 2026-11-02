/**
 * Smash Sporting Club's public scores feed (`GET https://scores.sscsportsacademy.com/api/public/schedule`),
 * read defensively into a small shape the importer plans with (plan.ts). Pure: no Node, browser or
 * Next.js APIs, so it runs in tests and on the server alike.
 *
 * The feed (Cairo junior team finals, Nov 2026): `courts[].courtNumber`, `courts[].matches[]` with
 * `status` scheduled|live|completed, `match_type` singles|doubles, `match_order`, `scheduled_at`
 * (unix seconds; 0 or null for a "followed by" match), `started_at` / `completed_at`, `winner_player`
 * 1|2, `players[]` {name, country_code, partner_name, partner_country} and `score` {sets: [[a,b]…],
 * setTiebreaks: ([a,b]|null)[], retired, walkover, abandoned, winner}. A recorder snapshot
 * (`{fetchedAt, schedule, live}`) is read the same way.
 */

export const SMASH_ZONE = "Africa/Cairo";

export interface SmashSide {
  /** Nation code as Smash writes it (ITF / IOC: "EGY"). */
  code: string;
  /** The player, then the partner in doubles. */
  names: string[];
}

export interface SmashMatch {
  id: string;
  court: number;
  status: string;
  type: "singles" | "doubles";
  order: number;
  /** The Cairo day the match was played (yyyy-mm-dd), from its start, end or scheduled time; null when unknown. */
  day: string | null;
  /** 1 = Smash's player 1 won, 2 = player 2; null when not given. */
  winner: 1 | 2 | null;
  sides: [SmashSide, SmashSide];
  /** Games per set from player 1's side first. A match tie-break may appear as its points ([10, 6]). */
  sets: [number, number][];
  /** Tie-break points per set, player 1 first; null where Smash gives none. */
  tiebreaks: ([number, number] | null)[];
  retired: boolean;
  walkover: boolean;
  abandoned: boolean;
  /** "regular_final_set" | "match_tiebreak" | … as Smash writes it. */
  finalSetRule: string | null;
}

export interface SmashSchedule {
  matches: SmashMatch[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
const whole = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

function pair(v: unknown): [number, number] | null {
  return Array.isArray(v) && v.length === 2 && whole(v[0]) && whole(v[1]) ? [v[0], v[1]] : null;
}

/** The Cairo calendar day of an instant, yyyy-mm-dd. */
export function cairoDay(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: SMASH_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/** Seconds since 1970 that look like a real time (not the 0 Smash writes for "followed by"). */
function realTime(v: unknown): number | null {
  const n = int(v);
  return n !== null && n > 1_000_000_000 ? n : null;
}

function side(v: unknown): SmashSide | null {
  if (!isObj(v)) return null;
  const code = str(v.country_code);
  const name = str(v.name);
  if (!code || !name) return null;
  const partner = str(v.partner_name);
  return { code: code.toUpperCase(), names: partner ? [name, partner] : [name] };
}

function match(court: number, v: unknown): SmashMatch | null {
  if (!isObj(v)) return null;
  const id = str(v.id);
  const status = str(v.status);
  const type = v.match_type === "singles" || v.match_type === "doubles" ? v.match_type : null;
  const players = Array.isArray(v.players) ? v.players.map(side) : [];
  if (!id || !status || !type || players.length !== 2 || !players[0] || !players[1]) return null;
  const score = isObj(v.score) ? v.score : {};
  const read = (Array.isArray(score.sets) ? score.sets : []).map(pair);
  // An unreadable set makes the whole score unreadable: the planner sends it to the desk.
  const sets = read.every((s): s is [number, number] => s !== null) ? read : [];
  const tbs = Array.isArray(score.setTiebreaks) ? score.setTiebreaks : [];
  const w = int(v.winner_player) ?? int(score.winner);
  // A started or finished match is dated by when it was played; a "followed by" one has no scheduled time.
  const when = realTime(v.started_at) ?? realTime(v.completed_at) ?? realTime(v.scheduled_at);
  return {
    id,
    court,
    status,
    type,
    order: int(v.match_order) ?? 0,
    day: when ? cairoDay(when * 1000) : null,
    winner: w === 1 || w === 2 ? w : null,
    sides: [players[0], players[1]],
    sets,
    tiebreaks: sets.map((_, i) => pair(tbs[i])),
    retired: score.retired === true,
    walkover: score.walkover === true,
    abandoned: score.abandoned === true,
    finalSetRule: str(v.final_set_rule) ?? str(score.finalSetRule),
  };
}

/** Reads the feed (or a recorder snapshot); throws when it is not the schedule at all. */
export function parseSmashSchedule(raw: unknown): SmashSchedule {
  const root = isObj(raw) && isObj(raw.schedule) ? raw.schedule : raw;
  if (!isObj(root) || !Array.isArray(root.courts)) throw new Error("Smash schedule: no courts");
  const matches: SmashMatch[] = [];
  for (const c of root.courts) {
    if (!isObj(c)) continue;
    const court = int(c.courtNumber);
    if (court === null || !Array.isArray(c.matches)) continue;
    for (const m of c.matches) {
      const parsed = match(court, m);
      if (parsed) matches.push(parsed);
    }
  }
  return { matches };
}

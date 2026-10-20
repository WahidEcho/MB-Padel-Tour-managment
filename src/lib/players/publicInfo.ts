/**
 * What a player page may say about a player beyond the name and the photo, and
 * their record at the event. Pure and framework-free (shared with the app
 * through @core).
 *
 * - ITF junior ranking: public ITF data the organiser types per player on the
 *   Nations page. Stored per tournament in `format_config.itfJuniorRanks`
 *   (player id → rank), next to the squads, so no migration is needed.
 * - Age: the players are minors, so an age is shown only when the organiser
 *   ticks "Show players' ages" (App tab, `app_skin.showAges`, off by default)
 *   and the player's linked profile has a birth year. Only the age leaves the
 *   server, never the birth year itself.
 */
import { isDoneStatus, type MMatch } from "../mobile/contract";

/** Highest rank accepted: the ITF junior list runs to a few thousand. */
export const ITF_RANK_MAX = 9999;

/** A typed ranking ("12", "#12"), or null when blank or not a rank. */
export function parseItfRank(raw: unknown): number | null {
  const s = String(raw ?? "").trim().replace(/^#/, "");
  if (!/^\d{1,4}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= ITF_RANK_MAX ? n : null;
}

/** The stored rankings, keeping only well-formed entries. */
export function itfRanksOf(formatConfig: { itfJuniorRanks?: unknown } | null | undefined): Record<string, number> {
  const raw = formatConfig?.itfJuniorRanks;
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = typeof v === "number" ? v : parseItfRank(v);
    if (typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= ITF_RANK_MAX) out[id] = n;
  }
  return out;
}

/** The rankings with `updates` applied (null clears a player's). */
export function withItfRanks(current: Record<string, number>, updates: Record<string, number | null>): Record<string, number> {
  const next = { ...current };
  for (const [id, n] of Object.entries(updates)) {
    if (n === null) delete next[id];
    else next[id] = n;
  }
  return next;
}

/** The year the event is played in (its start date), else this year. */
export function eventYear(startsOn: string | null | undefined, now: Date = new Date()): number {
  const y = startsOn ? Number(startsOn.slice(0, 4)) : NaN;
  return Number.isInteger(y) && y > 1900 ? y : now.getUTCFullYear();
}

/**
 * The age a player reaches in the event's year (ITF juniors go by birth year),
 * or null when the organiser does not publish ages or the year is implausible.
 */
export function publicAge(birthYear: number | null | undefined, year: number, published: boolean): number | null {
  if (!published || typeof birthYear !== "number" || !Number.isInteger(birthYear)) return null;
  const age = year - birthYear;
  return age >= 5 && age <= 99 ? age : null;
}

export interface WonLost {
  won: number;
  lost: number;
}

export interface PlayerRecord {
  /** Every finished match the player played (all kinds). */
  all: WonLost;
  /** Singles rubbers (S1, S2). */
  singles: WonLost;
  /** Doubles rubbers. */
  doubles: WonLost;
  /** Sets won and lost over the finished matches. */
  sets: WonLost;
}

type RecordMatch = Pick<MMatch, "a" | "b" | "aPlayers" | "bPlayers" | "tieId" | "rubberType" | "status" | "winner" | "score">;

/**
 * The player's side in a match, or null when they are not in it: named in the
 * line-up, or (outside team ties, where every player of a team plays) on the team.
 */
export function playerSide(m: RecordMatch, playerId: string, teamId: string): "A" | "B" | null {
  if (m.aPlayers.includes(playerId)) return "A";
  if (m.bPlayers.includes(playerId)) return "B";
  if (m.tieId) return null;
  if (m.a === teamId) return "A";
  if (m.b === teamId) return "B";
  return null;
}

/** The player's win–loss record at the event, singles and doubles apart. */
export function playerRecord(matches: RecordMatch[], playerId: string, teamId: string): PlayerRecord {
  const z = (): WonLost => ({ won: 0, lost: 0 });
  const r: PlayerRecord = { all: z(), singles: z(), doubles: z(), sets: z() };
  for (const m of matches) {
    const side = playerSide(m, playerId, teamId);
    if (!side || !isDoneStatus(m.status) || !m.winner) continue;
    const mine = side === "A" ? m.a : m.b;
    const key: keyof WonLost = m.winner === mine ? "won" : "lost";
    r.all[key]++;
    if (m.rubberType === "D") r.doubles[key]++;
    else if (m.rubberType) r.singles[key]++;
    for (const s of m.score?.sets ?? []) {
      const us = side === "A" ? s.a : s.b;
      const them = side === "A" ? s.b : s.a;
      if (us > them) r.sets.won++;
      else if (them > us) r.sets.lost++;
    }
  }
  return r;
}

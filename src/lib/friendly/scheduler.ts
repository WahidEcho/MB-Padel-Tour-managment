/**
 * Friendly-session schedule generation.
 *
 * Three pairing modes:
 *  - "fixed"     — partners are fixed for the session; opponents rotate.
 *                  Pairs meet via the existing circle-method round robin.
 *  - "americano" — partners rotate every round; every player is scored
 *                  individually. Greedy assignment minimises repeat partners
 *                  first and repeat opponents second.
 *  - "mexicano"  — partners are re-drawn each round from the live standings:
 *                  the top four players share court 1, the next four court 2,
 *                  and within each court the 1st and 4th ranked play the 2nd
 *                  and 3rd. Rounds must therefore be generated one at a time,
 *                  after the previous round's results are in.
 *
 * Invariants every generated round upholds:
 *  - a player never appears twice in the same round,
 *  - matches per round never exceed the available courts,
 *  - matches played and rest turns stay within one of each other where the
 *    player count allows it.
 *
 * Pure module: no database, no framework.
 */
import { roundRobin } from "../roundrobin";

export type PairingMode = "fixed" | "americano" | "mexicano";

/** A pair of players competing as one side. */
export type Side = [string, string];

export interface ScheduledMatch {
  round: number;
  /** 0-based index into the session's active court list. */
  courtIndex: number;
  teamA: Side;
  teamB: Side;
}

export interface ScheduledRound {
  round: number;
  matches: ScheduledMatch[];
  /** Players sitting this round out. */
  resting: string[];
}

export interface SchedulerOptions {
  courts: number;
  /** Hard cap on rounds, normally taken from the capacity estimate. */
  maxRounds?: number;
}

/** A partnership fixed for the whole session. */
export interface FixedPair {
  id: string;
  players: Side;
}

const PARTNER_WEIGHT = 3;
const OPPONENT_WEIGHT = 1;

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Running record of who has partnered/opposed whom, and who has played/rested. */
export interface History {
  partner: Map<string, number>;
  opponent: Map<string, number>;
  played: Map<string, number>;
  rested: Map<string, number>;
}

export function newHistory(players: string[]): History {
  const played = new Map<string, number>();
  const rested = new Map<string, number>();
  for (const p of players) {
    played.set(p, 0);
    rested.set(p, 0);
  }
  return { partner: new Map(), opponent: new Map(), played, rested };
}

function bump(m: Map<string, number>, key: string, by = 1): void {
  m.set(key, (m.get(key) ?? 0) + by);
}

function recordMatch(hist: History, teamA: Side, teamB: Side): void {
  bump(hist.partner, pairKey(teamA[0], teamA[1]));
  bump(hist.partner, pairKey(teamB[0], teamB[1]));
  for (const a of teamA) {
    for (const b of teamB) bump(hist.opponent, pairKey(a, b));
  }
  for (const p of [...teamA, ...teamB]) bump(hist.played, p);
}

/* ------------------------------------------------------------------ */
/* Fixed partners                                                      */
/* ------------------------------------------------------------------ */

/**
 * Pack a flat list of matchups into rounds, respecting court capacity and
 * never scheduling the same participant twice within one round.
 * `participantsOf` yields the ids that must not collide.
 */
function packIntoRounds<T>(
  matchups: T[],
  courts: number,
  participantsOf: (m: T) => string[]
): T[][] {
  const remaining = [...matchups];
  const rounds: T[][] = [];

  while (remaining.length > 0) {
    const round: T[] = [];
    const busy = new Set<string>();
    for (let i = 0; i < remaining.length && round.length < courts; ) {
      const parts = participantsOf(remaining[i]);
      if (parts.some((p) => busy.has(p))) {
        i++;
        continue;
      }
      parts.forEach((p) => busy.add(p));
      round.push(remaining[i]);
      remaining.splice(i, 1);
    }
    // Guard against an impossible configuration rather than looping forever.
    if (round.length === 0) break;
    rounds.push(round);
  }
  return rounds;
}

/**
 * Fixed-partner schedule: a round robin between pairs, packed onto the
 * available courts. Every pair meets every other pair once (subject to
 * `maxRounds`).
 */
export function generateFixedSchedule(
  pairs: FixedPair[],
  opts: SchedulerOptions
): ScheduledRound[] {
  if (pairs.length < 2 || opts.courts < 1) return [];

  const byId = new Map(pairs.map((p) => [p.id, p]));
  const matchups = roundRobin(pairs.map((p) => p.id));

  const packed = packIntoRounds(matchups, opts.courts, (m) => {
    const a = byId.get(m.teamA);
    const b = byId.get(m.teamB);
    return [...(a?.players ?? []), ...(b?.players ?? [])];
  });

  const limited = opts.maxRounds ? packed.slice(0, opts.maxRounds) : packed;
  const allPlayers = pairs.flatMap((p) => p.players);

  return limited.map((matchupsInRound, idx) => {
    const round = idx + 1;
    const matches: ScheduledMatch[] = matchupsInRound.map((m, courtIndex) => ({
      round,
      courtIndex,
      teamA: byId.get(m.teamA)!.players,
      teamB: byId.get(m.teamB)!.players,
    }));
    const playing = new Set(matches.flatMap((m) => [...m.teamA, ...m.teamB]));
    return {
      round,
      matches,
      resting: allPlayers.filter((p) => !playing.has(p)).sort(),
    };
  });
}

/* ------------------------------------------------------------------ */
/* Americano — rotating partners                                       */
/* ------------------------------------------------------------------ */

/** Cost of putting these four players on a court together. */
function groupCost(group: string[], hist: History): number {
  let cost = 0;
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      const k = pairKey(group[i], group[j]);
      cost += (hist.partner.get(k) ?? 0) * PARTNER_WEIGHT;
      cost += (hist.opponent.get(k) ?? 0) * OPPONENT_WEIGHT;
    }
  }
  return cost;
}

/** Pick the three companions for `anchor` that repeat the least history. */
function bestGroupOf4(anchor: string, pool: string[], hist: History): string[] {
  let best: string[] | null = null;
  let bestCost = Infinity;
  for (let i = 0; i < pool.length - 2; i++) {
    for (let j = i + 1; j < pool.length - 1; j++) {
      for (let k = j + 1; k < pool.length; k++) {
        const group = [anchor, pool[i], pool[j], pool[k]];
        const cost = groupCost(group, hist);
        if (cost < bestCost) {
          bestCost = cost;
          best = group;
        }
      }
    }
  }
  return best ?? [anchor, ...pool.slice(0, 3)];
}

/** Split four players into the two sides that repeat partnerships the least. */
export function splitIntoSides(group: string[], hist: History): { teamA: Side; teamB: Side } {
  const [w, x, y, z] = group;
  const options: { teamA: Side; teamB: Side }[] = [
    { teamA: [w, x], teamB: [y, z] },
    { teamA: [w, y], teamB: [x, z] },
    { teamA: [w, z], teamB: [x, y] },
  ];
  let best = options[0];
  let bestCost = Infinity;
  for (const opt of options) {
    const partnerCost =
      (hist.partner.get(pairKey(opt.teamA[0], opt.teamA[1])) ?? 0) +
      (hist.partner.get(pairKey(opt.teamB[0], opt.teamB[1])) ?? 0);
    let opponentCost = 0;
    for (const a of opt.teamA) {
      for (const b of opt.teamB) opponentCost += hist.opponent.get(pairKey(a, b)) ?? 0;
    }
    const cost = partnerCost * PARTNER_WEIGHT + opponentCost * OPPONENT_WEIGHT;
    if (cost < bestCost) {
      bestCost = cost;
      best = opt;
    }
  }
  return best;
}

/** Choose who sits out: those who have played most, then rested least. */
function pickResters(players: string[], count: number, hist: History): Set<string> {
  if (count <= 0) return new Set();
  const ordered = [...players].sort(
    (a, b) =>
      (hist.played.get(b) ?? 0) - (hist.played.get(a) ?? 0) ||
      (hist.rested.get(a) ?? 0) - (hist.rested.get(b) ?? 0) ||
      a.localeCompare(b)
  );
  return new Set(ordered.slice(0, count));
}

export function matchesPerRound(playerCount: number, courts: number): number {
  return Math.max(0, Math.min(courts, Math.floor(playerCount / 4)));
}

/**
 * Americano schedule: partners rotate every round so players meet as many
 * different partners as possible. Handles player counts that are not a
 * multiple of four by rotating who rests.
 */
export function generateAmericanoSchedule(
  playerIds: string[],
  opts: SchedulerOptions & { rounds: number }
): ScheduledRound[] {
  const players = [...playerIds].sort();
  const perRound = matchesPerRound(players.length, opts.courts);
  if (perRound === 0 || opts.rounds < 1) return [];

  const hist = newHistory(players);
  const rounds: ScheduledRound[] = [];
  const cap = opts.maxRounds ? Math.min(opts.rounds, opts.maxRounds) : opts.rounds;

  for (let r = 1; r <= cap; r++) {
    const restCount = players.length - perRound * 4;
    const resters = pickResters(players, restCount, hist);
    for (const p of resters) bump(hist.rested, p);

    // Least-played players get first claim on a court.
    const pool = players
      .filter((p) => !resters.has(p))
      .sort(
        (a, b) =>
          (hist.played.get(a) ?? 0) - (hist.played.get(b) ?? 0) || a.localeCompare(b)
      );

    const matches: ScheduledMatch[] = [];
    const available = [...pool];
    for (let courtIndex = 0; courtIndex < perRound; courtIndex++) {
      const anchor = available.shift()!;
      const group = bestGroupOf4(anchor, available, hist);
      const companions = group.slice(1);
      for (const c of companions) {
        available.splice(available.indexOf(c), 1);
      }
      const { teamA, teamB } = splitIntoSides(group, hist);
      recordMatch(hist, teamA, teamB);
      matches.push({ round: r, courtIndex, teamA, teamB });
    }

    rounds.push({ round: r, matches, resting: [...resters].sort() });
  }
  return rounds;
}

/* ------------------------------------------------------------------ */
/* Mexicano — standings-driven pairing                                 */
/* ------------------------------------------------------------------ */

/** Minimal standings shape needed to seed a Mexicano round. */
export interface MexicanoStanding {
  playerProfileId: string;
  points: number;
  gameDiff: number;
}

/**
 * Within-court pairing convention, ranks 1-4 best-to-worst on that court.
 * Three mutually incompatible conventions ship in production; clubs migrating
 * from another app expect their existing one, so this is per-session.
 */
export type MexicanoPairing = "balanced_1_4" | "semi_1_3" | "top_heavy_1_2";

/** Split a ranked quad into two sides per the chosen convention. */
export function pairQuad(
  quad: string[],
  convention: MexicanoPairing
): { teamA: Side; teamB: Side } {
  const [first, second, third, fourth] = quad;
  switch (convention) {
    case "semi_1_3":
      return { teamA: [first, third], teamB: [second, fourth] };
    case "top_heavy_1_2":
      return { teamA: [first, second], teamB: [third, fourth] };
    case "balanced_1_4":
    default:
      return { teamA: [first, fourth], teamB: [second, third] };
  }
}

/**
 * Deterministic shuffle (mulberry32 + Fisher-Yates).
 * Round 1 of a Mexicano is a random draw, but it must be reproducible: the
 * seed is stored on the session so regenerating a schedule gives the same
 * draw rather than silently reshuffling an event that has already started.
 */
export function seededShuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Build one Mexicano round from the current standings.
 *
 * Players are ranked, then taken four at a time: the strongest court first.
 * Within each court the 1st and 4th ranked play the 2nd and 3rd, which is the
 * conventional Mexicano split that keeps the match close. Because it depends
 * on live results, callers generate one round at a time rather than a whole
 * schedule up front.
 *
 * `previousRests` lets rest turns stay balanced across rounds; players who
 * have rested least sit out first when the count is not a multiple of four.
 */
export function nextMexicanoRound(
  standings: MexicanoStanding[],
  round: number,
  opts: SchedulerOptions & { convention?: MexicanoPairing; drawSeed?: number },
  previousRests: Map<string, number> = new Map()
): ScheduledRound {
  const convention = opts.convention ?? "balanced_1_4";

  // Round 1 is a random draw (unanimous across sources). Everyone is on zero
  // points, so ranking would otherwise fall through to a deterministic id sort
  // and produce the same "random" draw every time.
  const isFirstRound = round <= 1 || standings.every((s) => s.points === 0);
  const ranked = isFirstRound
    ? seededShuffle(standings, opts.drawSeed ?? 1)
    : [...standings].sort(
        (a, b) =>
          b.points - a.points ||
          b.gameDiff - a.gameDiff ||
          a.playerProfileId.localeCompare(b.playerProfileId)
      );
  const perRound = matchesPerRound(ranked.length, opts.courts);
  const restCount = ranked.length - perRound * 4;

  // Rest the players who have rested least so far (lowest rank breaks ties).
  const resters = new Set(
    [...ranked]
      .sort(
        (a, b) =>
          (previousRests.get(a.playerProfileId) ?? 0) - (previousRests.get(b.playerProfileId) ?? 0) ||
          a.points - b.points ||
          a.playerProfileId.localeCompare(b.playerProfileId)
      )
      .slice(0, Math.max(0, restCount))
      .map((s) => s.playerProfileId)
  );

  const playing = ranked.filter((s) => !resters.has(s.playerProfileId));
  const matches: ScheduledMatch[] = [];
  for (let courtIndex = 0; courtIndex < perRound; courtIndex++) {
    const quad = playing.slice(courtIndex * 4, courtIndex * 4 + 4).map((s) => s.playerProfileId);
    if (quad.length < 4) break;
    const { teamA, teamB } = pairQuad(quad, convention);
    matches.push({ round, courtIndex, teamA, teamB });
  }

  return { round, matches, resting: [...resters].sort() };
}

/* ------------------------------------------------------------------ */
/* Validation and reporting                                            */
/* ------------------------------------------------------------------ */

export interface ScheduleIssue {
  round: number;
  kind: "duplicate_player" | "court_overflow" | "incomplete_match";
  detail: string;
}

/** Structural validation — these are bugs, not warnings, if they ever fire. */
export function validateSchedule(rounds: ScheduledRound[], courts: number): ScheduleIssue[] {
  const issues: ScheduleIssue[] = [];
  for (const r of rounds) {
    if (r.matches.length > courts) {
      issues.push({
        round: r.round,
        kind: "court_overflow",
        detail: `${r.matches.length} matches on ${courts} courts`,
      });
    }
    const seen = new Set<string>();
    for (const m of r.matches) {
      const parts = [...m.teamA, ...m.teamB];
      if (new Set(parts).size !== 4) {
        issues.push({
          round: r.round,
          kind: "incomplete_match",
          detail: `court ${m.courtIndex} has a repeated player`,
        });
      }
      for (const p of parts) {
        if (seen.has(p)) {
          issues.push({
            round: r.round,
            kind: "duplicate_player",
            detail: `${p} appears on two courts`,
          });
        }
        seen.add(p);
      }
    }
  }
  return issues;
}

export interface PlayerLoad {
  playerProfileId: string;
  played: number;
  rested: number;
}

/** Matches played and rest turns per player across a schedule. */
export function playerLoads(rounds: ScheduledRound[]): PlayerLoad[] {
  const played = new Map<string, number>();
  const rested = new Map<string, number>();
  for (const r of rounds) {
    for (const m of r.matches) {
      for (const p of [...m.teamA, ...m.teamB]) bump(played, p);
    }
    for (const p of r.resting) bump(rested, p);
  }
  const ids = new Set([...played.keys(), ...rested.keys()]);
  return [...ids].sort().map((playerProfileId) => ({
    playerProfileId,
    played: played.get(playerProfileId) ?? 0,
    rested: rested.get(playerProfileId) ?? 0,
  }));
}

/** Spread between the busiest and least busy player. 0 or 1 is well balanced. */
export function loadSpread(rounds: ScheduledRound[]): number {
  const loads = playerLoads(rounds);
  if (loads.length === 0) return 0;
  const counts = loads.map((l) => l.played);
  return Math.max(...counts) - Math.min(...counts);
}

/** How many distinct partners each player had — the point of Americano. */
export function partnerVariety(rounds: ScheduledRound[]): Map<string, number> {
  const partners = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    if (!partners.has(a)) partners.set(a, new Set());
    partners.get(a)!.add(b);
  };
  for (const r of rounds) {
    for (const m of r.matches) {
      add(m.teamA[0], m.teamA[1]);
      add(m.teamA[1], m.teamA[0]);
      add(m.teamB[0], m.teamB[1]);
      add(m.teamB[1], m.teamB[0]);
    }
  }
  return new Map([...partners.entries()].map(([k, v]) => [k, v.size]));
}

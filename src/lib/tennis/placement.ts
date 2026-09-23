/**
 * Placement draws: after the groups, every nation plays on until its final place
 * is decided. Pure.
 *
 * Groups of four split into draws by finishing position: the top two of each
 * group play for places 1–8, the third and fourth for 9–16 (with four groups).
 * Each draw is a classification bracket — winners of a round play on for the
 * higher block of places, losers for the lower — so a draw of eight is three
 * rounds and every tie in its last round is played for two exact places.
 */

/** Where a side of a tie comes from. */
export type Source =
  | { kind: "group"; group: number; position: number }
  | { kind: "winner"; key: string }
  | { kind: "loser"; key: string };

export interface PlannedTie {
  key: string;
  drawFrom: number;
  drawTo: number;
  roundNo: number;
  roundName: string;
  /** The block of places this tie's round is playing for, e.g. 5–8. */
  blockFrom: number;
  blockTo: number;
  /** Order within its block, top of the draw first. */
  slot: number;
  /** Set when the tie decides two exact places (a final or a play-off). */
  placesFrom: number | null;
  placesTo: number | null;
  a: Source;
  b: Source;
  winnerTo: { key: string; side: "A" | "B" } | null;
  loserTo: { key: string; side: "A" | "B" } | null;
}

export function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${s}`;
}

function blockName(lo: number, hi: number): string {
  const size = hi - lo + 1;
  if (size === 2) {
    if (lo === 1) return "Final";
    if (lo === 3) return "Third place";
    return `${ordinal(lo)} place play-off`;
  }
  if (lo === 1) return size === 4 ? "Semi-finals" : size === 8 ? "Quarter-finals" : `Round of ${size}`;
  return `${ordinal(lo)}–${ordinal(hi)} play-offs`;
}

const LETTER = (g: number) => String.fromCharCode(65 + g);

/**
 * First-round lines for a draw fed by two finishing positions, top to bottom.
 * No first-round tie is a group rematch, and a group's two nations start in
 * opposite halves. With four groups the pairing is the ITF's: A plays C, B
 * plays D, and group D's nation takes the bottom line.
 */
export function firstRoundLines(groupCount: number, high: number, low: number): Source[] {
  const g = (group: number, position: number): Source => ({ kind: "group", group, position });
  if (groupCount === 4) {
    return [g(0, high), g(2, low), g(3, low), g(1, high), g(2, high), g(0, low), g(1, low), g(3, high)];
  }
  if (groupCount === 2) return [g(0, high), g(1, low), g(1, high), g(0, low)];
  // Any other even count: pair each group's higher finisher with the group half
  // the draw away, alternating halves so no group lands in one half twice.
  const half = groupCount / 2;
  const lines: Source[] = [];
  for (let i = 0; i < groupCount; i++) lines.push(g(i, high), g((i + half) % groupCount, low));
  return lines;
}

/**
 * The full placement plan for `groupCount` groups of `groupSize`. Group sizes
 * must be even and `2 × groupCount` a power of two (2, 4 or 8 groups).
 */
export function placementPlan(groupCount: number, groupSize: number): PlannedTie[] {
  const drawSize = groupCount * 2;
  if (groupSize % 2 !== 0) throw new Error("Placement draws need an even number of nations per group.");
  if ((drawSize & (drawSize - 1)) !== 0) throw new Error("Placement draws need 1, 2, 4 or 8 groups.");
  const ties: PlannedTie[] = [];

  const block = (lo: number, hi: number, entrants: Source[], roundNo: number, drawFrom: number, drawTo: number) => {
    const size = hi - lo + 1;
    const here: PlannedTie[] = [];
    for (let i = 0; i < size / 2; i++) {
      const key = `${drawFrom}-${drawTo}:${lo}-${hi}:${i}`;
      here.push({
        key,
        drawFrom,
        drawTo,
        roundNo,
        roundName: blockName(lo, hi),
        blockFrom: lo,
        blockTo: hi,
        slot: i,
        placesFrom: size === 2 ? lo : null,
        placesTo: size === 2 ? hi : null,
        a: entrants[2 * i],
        b: entrants[2 * i + 1],
        winnerTo: null,
        loserTo: null,
      });
    }
    ties.push(...here);
    if (size === 2) return;
    const mid = lo + size / 2 - 1;
    block(lo, mid, here.map((t) => ({ kind: "winner", key: t.key })), roundNo + 1, drawFrom, drawTo);
    block(mid + 1, hi, here.map((t) => ({ kind: "loser", key: t.key })), roundNo + 1, drawFrom, drawTo);
  };

  for (let d = 0; d < groupSize / 2; d++) {
    const high = 2 * d + 1;
    const from = 2 * d * groupCount + 1;
    const to = from + drawSize - 1;
    block(from, to, firstRoundLines(groupCount, high, high + 1), 1, from, to);
  }

  // Point every tie at where its winner and loser go next.
  const byKey = new Map(ties.map((t) => [t.key, t]));
  for (const t of ties) {
    for (const side of ["a", "b"] as const) {
      const src = t[side];
      if (src.kind === "group") continue;
      const feeder = byKey.get(src.key)!;
      const target = { key: t.key, side: side === "a" ? ("A" as const) : ("B" as const) };
      if (src.kind === "winner") feeder.winnerTo = target;
      else feeder.loserTo = target;
    }
  }
  return ties.sort((x, y) => x.roundNo - y.roundNo || x.blockFrom - y.blockFrom || x.slot - y.slot);
}

/** "A1", "C2" — how a group source is written on a draw sheet. */
export function sourceLabel(src: Source): string {
  if (src.kind === "group") return `${LETTER(src.group)}${src.position}`;
  return src.kind === "winner" ? "Winner" : "Loser";
}

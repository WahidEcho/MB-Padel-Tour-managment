/**
 * Knockout bracket generation (spec §16).
 *
 * Physical bracket layout: round slots are paired (0,1), (2,3), ... and the
 * winner of match m advances to slot m of the next round. Semi-final losers
 * feed the third-place match.
 */
import type { BracketTier, FormatConfig } from "./types";

export interface Qualifier {
  teamId: string;
  groupOrder: number; // 0-based group index (A=0)
  rank: number; // rank inside the group, 1-based
}

export interface PlannedSlot {
  slotOrder: number;
  teamId: string | null;
  isBye: boolean;
  sourceType: string | null;
  sourceRef: string | null;
}

export interface PlannedRound {
  roundName: string;
  slots: PlannedSlot[];
}

export function roundNameForSize(size: number): string {
  switch (size) {
    case 2:
      return "F";
    case 4:
      return "SF";
    case 8:
      return "QF";
    default:
      return `R${size}`;
  }
}

export function stageForRound(roundName: string): string {
  switch (roundName) {
    case "F":
      return "final";
    case "SF":
      return "semi_final";
    case "QF":
      return "quarter_final";
    case "TP":
      return "third_place";
    default:
      return "knockout";
  }
}

/**
 * How early a round is played, lowest first: R32, R16, QF, SF, TP, F.
 *
 * `getBracketSlots` orders slots by `slot_order` alone, and every round has a
 * slot 0 — so the order rounds come out of a query is the order the rows happen
 * to sit in, not the order they are played. Anything that walks rounds in
 * sequence (assigning courts, numbering matches) has to sort them itself.
 *
 * The third-place match sits between the semis and the final, which is when it
 * is actually played.
 */
export function roundSequence(roundName: string): number {
  switch (roundName) {
    case "TP":
      return 997;
    case "F":
      return 998;
    case "SF":
      return 996;
    case "QF":
      return 992;
    default: {
      const size = parseInt(roundName.slice(1), 10);
      // A bigger round is played earlier. Unrecognised names sort first, so a
      // future round name cannot silently end up after the final.
      return Number.isFinite(size) && size > 0 ? 1000 - size : -1;
    }
  }
}

/** Round names in the order they are played. */
export function orderedRoundNames(roundNames: string[]): string[] {
  return [...new Set(roundNames)].sort((a, b) => roundSequence(a) - roundSequence(b));
}

export function roundLabel(roundName: string): string {
  switch (roundName) {
    case "F":
      return "Final";
    case "SF":
      return "Semi-final";
    case "QF":
      return "Quarter-final";
    case "TP":
      return "Third-place match";
    default:
      return `Round of ${roundName.slice(1)}`;
  }
}

function nextPowerOfTwo(n: number): number {
  let p = 2;
  while (p < n) p *= 2;
  return p;
}

/** Classic seeding order: position list so seed 1 meets seed 2 only in the final. */
function seedPositions(size: number): number[] {
  let order = [1, 2];
  while (order.length < size) {
    const next: number[] = [];
    const m = order.length * 2 + 1;
    for (const s of order) {
      next.push(s, m - s);
    }
    order = next;
  }
  return order;
}

/**
 * Cross-group pairing per spec §16.2 for the common case (every group
 * contributes exactly 2 qualifiers and the group count is even):
 * A1-B2 / B1-A2 / C1-D2 / D1-C2, halves split so group-mates can only
 * meet again in the final.
 */
function crossGroupEntrants(qualifiers: Qualifier[]): string[] | null {
  const groups = new Map<number, Qualifier[]>();
  for (const q of qualifiers) {
    if (!groups.has(q.groupOrder)) groups.set(q.groupOrder, []);
    groups.get(q.groupOrder)!.push(q);
  }
  const groupOrders = [...groups.keys()].sort((a, b) => a - b);
  if (groupOrders.length % 2 !== 0) return null;
  for (const g of groupOrders) {
    const qs = groups.get(g)!;
    if (qs.length !== 2) return null;
  }
  // Rank-relative, not literally ranks 1 and 2. The Plate bracket is drawn from
  // the teams placed 3rd and 4th, and it wants the same cross-group draw — each
  // group's better-placed team meeting the other group's worse-placed one. For a
  // Cup of ranks 1 and 2 this is identical to matching on the rank numbers.
  const byRank = (g: number) => [...groups.get(g)!].sort((a, b) => a.rank - b.rank);
  const first = (g: number) => byRank(g)[0]?.teamId;
  const second = (g: number) => byRank(g)[1]?.teamId;

  const pairings: [string, string][] = [];
  for (let i = 0; i < groupOrders.length; i += 2) {
    const x = groupOrders[i];
    const y = groupOrders[i + 1];
    const x1 = first(x);
    const x2 = second(x);
    const y1 = first(y);
    const y2 = second(y);
    if (!x1 || !x2 || !y1 || !y2) return null;
    pairings.push([x1, y2], [y1, x2]);
  }
  // Spread sibling pairings into opposite halves: evens first, then odds
  const physical: [string, string][] = [
    ...pairings.filter((_, i) => i % 2 === 0),
    ...pairings.filter((_, i) => i % 2 === 1),
  ];
  return physical.flat();
}

export function buildBracketPlan(qualifiers: Qualifier[], thirdPlaceMatch: boolean): PlannedRound[] {
  if (qualifiers.length < 2) throw new Error("Need at least 2 qualified teams");
  const n = qualifiers.length;
  const size = nextPowerOfTwo(n);
  const rounds: PlannedRound[] = [];

  // First-round slot assignment
  const firstRound: PlannedSlot[] = Array.from({ length: size }, (_, i) => ({
    slotOrder: i,
    teamId: null,
    isBye: false,
    sourceType: null,
    sourceRef: null,
  }));

  const cross = n === size ? crossGroupEntrants(qualifiers) : null;
  if (cross) {
    cross.forEach((teamId, i) => {
      firstRound[i].teamId = teamId;
      firstRound[i].sourceType = "group_rank";
    });
  } else {
    // Seed by rank, then group order; byes ("lucky teams") go to top seeds
    const seeds = [...qualifiers].sort((a, b) => a.rank - b.rank || a.groupOrder - b.groupOrder);
    const positions = seedPositions(size);
    positions.forEach((seedNumber, pos) => {
      const slot = firstRound[pos];
      if (seedNumber <= n) {
        slot.teamId = seeds[seedNumber - 1].teamId;
        slot.sourceType = "group_rank";
      } else {
        slot.isBye = true;
        slot.sourceType = "bye";
      }
    });
  }

  let currentSize = size;
  while (currentSize >= 2) {
    const roundName = roundNameForSize(currentSize);
    if (currentSize === size) {
      rounds.push({ roundName, slots: firstRound });
    } else {
      rounds.push({
        roundName,
        slots: Array.from({ length: currentSize }, (_, i) => ({
          slotOrder: i,
          teamId: null,
          isBye: false,
          sourceType: "match_winner",
          sourceRef: `${roundNameForSize(currentSize * 2)}:${i}`,
        })),
      });
    }
    currentSize /= 2;
  }

  if (thirdPlaceMatch && size >= 4) {
    rounds.push({
      roundName: "TP",
      slots: [0, 1].map((i) => ({
        slotOrder: i,
        teamId: null,
        isBye: false,
        sourceType: "match_loser",
        sourceRef: `SF:${i}`,
      })),
    });
  }

  return rounds;
}

/** The round that the winner of match `matchIndex` in `roundName` advances to. */
export function advanceTarget(
  roundName: string,
  matchIndex: number
): { roundName: string; slotOrder: number } | null {
  if (roundName === "F" || roundName === "TP") return null;
  const size = roundName === "SF" ? 4 : roundName === "QF" ? 8 : parseInt(roundName.slice(1), 10);
  if (!size || size < 4) return null;
  return { roundName: roundNameForSize(size / 2), slotOrder: matchIndex };
}


/* ------------------------------------------------------------------ */
/* Two tiers from one group stage                                      */
/* ------------------------------------------------------------------ */

/**
 * How many places per group each tier takes.
 *
 * `platePerGroup` is 0 unless the Plate has been turned on, so a tournament
 * that never touches it behaves exactly as it did with one bracket.
 */
export function tierSizes(format: FormatConfig | null | undefined): {
  qualifyPerGroup: number;
  platePerGroup: number;
} {
  const qualifyPerGroup = Math.max(1, format?.qualifyPerGroup ?? 2);
  const plate = format?.tiers?.plate;
  return {
    qualifyPerGroup,
    platePerGroup: plate?.enabled ? Math.max(1, plate.perGroup ?? 2) : 0,
  };
}

/**
 * Whether a tier plays a third-place match.
 *
 * The Cup falls back to the legacy top-level flag, so existing tournaments keep
 * their setting. The Plate falls back to the Cup's, so enabling the Plate does
 * not silently change how it finishes.
 */
export function thirdPlaceFor(format: FormatConfig | null | undefined, tier: BracketTier): boolean {
  const cup = format?.tiers?.cup?.thirdPlaceMatch ?? format?.thirdPlaceMatch ?? true;
  if (tier === "cup") return cup;
  return format?.tiers?.plate?.thirdPlaceMatch ?? cup;
}

/**
 * How many places a tier's podium shows.
 *
 * Capped at what the bracket can actually produce: third and fourth place only
 * exist when a third-place match was played, so a deeper setting is reported
 * rather than rendering blank cards on a venue screen.
 */
export function podiumDepthFor(format: FormatConfig | null | undefined, tier: BracketTier): 1 | 2 | 3 | 4 {
  const configured = (tier === "plate" ? format?.tiers?.plate?.podiumDepth : format?.tiers?.cup?.podiumDepth) ?? 3;
  const cap = thirdPlaceFor(format, tier) ? 4 : 2;
  return Math.min(configured, cap) as 1 | 2 | 3 | 4;
}

export interface PodiumProblem {
  tier: BracketTier;
  message: string;
}

/** Refuses a podium depth the bracket cannot fill. Used on save, before it airs. */
export function validatePodiumSettings(format: FormatConfig | null | undefined): PodiumProblem[] {
  const problems: PodiumProblem[] = [];
  const tiers: BracketTier[] = format?.tiers?.plate?.enabled ? ["cup", "plate"] : ["cup"];
  for (const tier of tiers) {
    const configured = (tier === "plate" ? format?.tiers?.plate?.podiumDepth : format?.tiers?.cup?.podiumDepth) ?? 3;
    if (configured >= 3 && !thirdPlaceFor(format, tier)) {
      problems.push({
        tier,
        message: `A ${configured}-place ${tier === "plate" ? "Plate" : "Cup"} podium needs a third-place match — without one the losing semi-finalists are tied and there is no honest 3rd and 4th.`,
      });
    }
  }
  return problems;
}


/** How the two tiers share the court pool once both are drawn. */
export type CourtStrategy = "parallel" | "sequential";

export interface PlannedMatch {
  tier: BracketTier;
  roundName: string;
  /** 0-based position of the match within its round. */
  matchIndex: number;
}

export interface ScheduledMatch extends PlannedMatch {
  /** Index into the court list, or null when the tournament has no courts. */
  courtIndex: number | null;
  /** 0-based play order across the whole knockout. */
  order: number;
}

/**
 * Puts every knockout match of both tiers in play order and on a court.
 *
 * Grouped by round level first, because a semi-final cannot be played before the
 * quarter-finals that feed it however the tiers are arranged. Within a level the
 * strategy decides:
 *
 *   parallel   — the tiers are interleaved and spread across the whole court
 *                pool, so Cup and Plate matches of the same round run side by
 *                side. This is what "both brackets at once" means, and it can
 *                only be done by ordering both tiers together; publishing one
 *                tier and then the other can never produce it, because the first
 *                tier would already hold every court and every low order number.
 *   sequential — the Cup plays its whole round first, then the Plate plays the
 *                same round on the same courts. Court indexes repeat across the
 *                two tiers on purpose: they are separated in time, not in space.
 */
export function orderKnockoutMatches(
  matches: PlannedMatch[],
  courtCount: number,
  strategy: CourtStrategy,
): ScheduledMatch[] {
  const levels = orderedRoundNames(matches.map((m) => m.roundName));
  const out: ScheduledMatch[] = [];
  let order = 0;

  for (const roundName of levels) {
    const inRound = matches.filter((m) => m.roundName === roundName);
    const cup = inRound.filter((m) => m.tier === "cup").sort((a, b) => a.matchIndex - b.matchIndex);
    const plate = inRound.filter((m) => m.tier === "plate").sort((a, b) => a.matchIndex - b.matchIndex);

    if (strategy === "sequential") {
      for (const group of [cup, plate]) {
        group.forEach((m, i) => {
          out.push({ ...m, courtIndex: courtCount > 0 ? i % courtCount : null, order: order++ });
        });
      }
      continue;
    }

    // Interleave, so neither tier waits for the other to finish the round.
    const woven: PlannedMatch[] = [];
    for (let i = 0; i < Math.max(cup.length, plate.length); i++) {
      if (cup[i]) woven.push(cup[i]);
      if (plate[i]) woven.push(plate[i]);
    }
    woven.forEach((m, i) => {
      out.push({ ...m, courtIndex: courtCount > 0 ? i % courtCount : null, order: order++ });
    });
  }

  return out;
}

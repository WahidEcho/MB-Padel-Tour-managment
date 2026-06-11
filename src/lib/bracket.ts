/**
 * Knockout bracket generation (spec §16).
 *
 * Physical bracket layout: round slots are paired (0,1), (2,3), ... and the
 * winner of match m advances to slot m of the next round. Semi-final losers
 * feed the third-place match.
 */
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
  const first = (g: number) => groups.get(g)!.find((q) => q.rank === 1)?.teamId;
  const second = (g: number) => groups.get(g)!.find((q) => q.rank === 2)?.teamId;

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

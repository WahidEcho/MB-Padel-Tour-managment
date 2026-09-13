/**
 * The closing ceremony, as a sequence of steps.
 *
 * Pure. The operator presses NEXT PLACE and the wall reveals the podium from the
 * bottom up. With two brackets the Plate goes first and the Cup last, the way a
 * real ceremony saves the main trophy for the end. Each tier opens on a slate.
 *
 * A place can hold more than one entrant: a friendly session's ranking can tie,
 * and tied players are revealed together on one step.
 */

export interface CeremonyPerson {
  id: string;
  name: string;
  photo_url: string | null;
  portrait_url: string | null;
  focal_x: number;
  focal_y: number;
}

export interface CeremonyEntrant {
  /** A team name, or a player's public name for a session. */
  title: string;
  /** The players, shown with their photos under the title. */
  people: CeremonyPerson[];
}

export interface CeremonyPlace {
  place: number;
  entrants: CeremonyEntrant[];
}

export interface CeremonyTier {
  key: string;
  /** "Plate", "Cup", or the session's name. */
  label: string;
  /** Sorted by place, champion first. Only places that have been decided. */
  places: CeremonyPlace[];
  /** How many places the settings ask for, to tell the operator when fewer are decided. */
  configuredDepth: number;
}

export type CeremonyStep =
  | { kind: "slate"; tierIndex: number }
  | { kind: "place"; tierIndex: number; place: number };

/** Slate, then deepest place up to the champion, per tier, in the order given. */
export function ceremonySteps(tiers: CeremonyTier[]): CeremonyStep[] {
  const steps: CeremonyStep[] = [];
  tiers.forEach((tier, tierIndex) => {
    if (tier.places.length === 0) return;
    steps.push({ kind: "slate", tierIndex });
    const deepestFirst = [...tier.places].sort((a, b) => b.place - a.place);
    for (const p of deepestFirst) steps.push({ kind: "place", tierIndex, place: p.place });
  });
  return steps;
}

/** The step a stored index points at, clamped so a stale index never shows nothing. */
export function stepAt(steps: CeremonyStep[], index: number): { step: CeremonyStep | null; index: number } {
  if (steps.length === 0) return { step: null, index: 0 };
  const i = Math.min(Math.max(0, Math.floor(index)), steps.length - 1);
  return { step: steps[i], index: i };
}

/** The places of the step's tier that are on the stage at this step, champion first. */
export function revealedPlaces(tiers: CeremonyTier[], step: CeremonyStep | null): CeremonyPlace[] {
  if (!step || step.kind === "slate") return [];
  const tier = tiers[step.tierIndex];
  return tier.places.filter((p) => p.place >= step.place).sort((a, b) => a.place - b.place);
}

const ORDINAL: Record<number, string> = { 1: "Champion", 2: "2nd place", 3: "3rd place", 4: "4th place" };

export function placeLabel(place: number): string {
  return ORDINAL[place] ?? `${place}th place`;
}

/** What the operator reads: "Plate — 2nd place (3 of 8)". */
export function describeStep(tiers: CeremonyTier[], steps: CeremonyStep[], index: number): string {
  const { step, index: i } = stepAt(steps, index);
  if (!step) return "Nothing to reveal yet — no podium has been decided.";
  const tier = tiers[step.tierIndex];
  const what = step.kind === "slate" ? "opening slate" : placeLabel(step.place);
  return `${tier.label} — ${what} (${i + 1} of ${steps.length})`;
}

/** How many people stand on a tier's podium: tied players share a place but each counts. */
export function podiumCount(tier: CeremonyTier): number {
  return tier.places.reduce((n, p) => n + p.entrants.length, 0);
}

/**
 * How deep a tier's decided podium reaches. Ties count as the ranks they cover:
 * ranks 1, 2, 2 fill a three-place podium even though only two places exist.
 */
function coveredDepth(tier: CeremonyTier): number {
  return tier.places.reduce((deepest, p) => Math.max(deepest, p.place + p.entrants.length - 1), 0);
}

/** Tiers whose settings ask for more places than have been decided. */
export function shortTiers(tiers: CeremonyTier[]): string[] {
  return tiers
    .filter((t) => t.places.length > 0 && coveredDepth(t) < t.configuredDepth)
    .map((t) => {
      const decided = coveredDepth(t);
      return `${t.label} is set to ${t.configuredDepth} places but only ${decided} ${decided === 1 ? "is" : "are"} decided`;
    });
}

/**
 * A session's podium from its ranking. Ties share a place, so two players on
 * equal rank 2 are both "2nd" and revealed on one step, and the next rank shown
 * is whatever the ranking says (standard competition ranking: 1, 2, 2, 4).
 */
export function sessionCeremonyTier(
  label: string,
  ranking: { player_profile_id: string; rank: number; points: number }[],
  players: Map<string, CeremonyPerson>,
  depth: number,
): CeremonyTier {
  const byRank = new Map<number, CeremonyEntrant[]>();
  for (const row of [...ranking].sort((a, b) => a.rank - b.rank)) {
    if (row.rank < 1 || row.rank > depth) continue;
    const person = players.get(row.player_profile_id);
    if (!person) continue;
    const list = byRank.get(row.rank) ?? [];
    list.push({ title: person.name, people: [person] });
    byRank.set(row.rank, list);
  }
  return {
    key: "session",
    label,
    places: [...byRank.entries()].sort((a, b) => a[0] - b[0]).map(([place, entrants]) => ({ place, entrants })),
    configuredDepth: depth,
  };
}

/** Timeline of one step's build on the wall, seeked from the stamp. */
export const CEREMONY = {
  /** Slate or card rises in. */
  riseMs: 1400,
  /** The champion's accent flood and confetti. */
  floodMs: 2600,
  /**
   * How late a wall may join a step and still play what is left of its build.
   * The longest confetti piece ends about 4.3s after the stamp, and a wall can
   * learn of a step up to one poll late; past this it shows the settled frame.
   */
  skipAfterMs: 6500,
};

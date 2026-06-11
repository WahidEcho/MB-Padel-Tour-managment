/**
 * Round-robin scheduling using the circle method.
 * For an odd number of teams a BYE placeholder is inserted: the team paired
 * with BYE rests that round (spec §9.4 — rest only, not qualification).
 */
export interface RoundRobinPairing<T> {
  round: number;
  teamA: T;
  teamB: T;
}

export function roundRobin<T>(teams: T[]): RoundRobinPairing<T>[] {
  const list: (T | null)[] = [...teams];
  if (list.length < 2) return [];
  if (list.length % 2 === 1) list.push(null); // BYE

  const n = list.length;
  const rounds = n - 1;
  const pairings: RoundRobinPairing<T>[] = [];

  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < n / 2; i++) {
      const a = list[i];
      const b = list[n - 1 - i];
      if (a !== null && b !== null) {
        pairings.push({ round: r + 1, teamA: a, teamB: b });
      }
    }
    // Rotate all but the first element
    list.splice(1, 0, list.pop() as T | null);
  }
  return pairings;
}

export function matchesPerGroup(teamCount: number): number {
  return (teamCount * (teamCount - 1)) / 2;
}

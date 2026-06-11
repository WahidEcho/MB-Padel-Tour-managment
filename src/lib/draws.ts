/**
 * Group draw generation (spec §9.2, §10).
 * Distributes teams into groups as evenly as possible, honouring locked
 * team→group assignments; only unlocked teams are shuffled.
 */
export interface DrawOption {
  /** groupIndex → team ids in order */
  groups: string[][];
}

export function groupSizes(teamCount: number, groupCount: number): number[] {
  const base = Math.floor(teamCount / groupCount);
  const extra = teamCount % groupCount;
  return Array.from({ length: groupCount }, (_, i) => base + (i < extra ? 1 : 0));
}

export function groupName(index: number): string {
  return `Group ${String.fromCharCode(65 + index)}`;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function generateDraw(
  teamIds: string[],
  groupCount: number,
  locked: Record<string, number> = {}
): DrawOption {
  const sizes = groupSizes(teamIds.length, groupCount);
  const groups: string[][] = Array.from({ length: groupCount }, () => []);

  for (const [teamId, gi] of Object.entries(locked)) {
    if (gi >= 0 && gi < groupCount && teamIds.includes(teamId)) {
      if (groups[gi].length >= sizes[gi]) {
        throw new Error(`${groupName(gi)} is full of locked teams`);
      }
      groups[gi].push(teamId);
    }
  }

  const unlocked = shuffle(teamIds.filter((t) => !(t in locked)));
  for (const teamId of unlocked) {
    const gi = groups.findIndex((g, i) => g.length < sizes[i]);
    if (gi === -1) throw new Error("No space left in any group");
    groups[gi].push(teamId);
  }
  return { groups };
}

export function generateDrawOptions(
  teamIds: string[],
  groupCount: number,
  locked: Record<string, number> = {},
  optionCount = 5
): DrawOption[] {
  const options: DrawOption[] = [];
  const seen = new Set<string>();
  // Generous attempt budget so small team counts still yield distinct options
  for (let attempt = 0; attempt < optionCount * 20 && options.length < optionCount; attempt++) {
    const draw = generateDraw(teamIds, groupCount, locked);
    const key = draw.groups.map((g) => [...g].sort().join(",")).join("|");
    if (!seen.has(key)) {
      seen.add(key);
      options.push(draw);
    }
  }
  if (options.length === 0) options.push(generateDraw(teamIds, groupCount, locked));
  return options;
}

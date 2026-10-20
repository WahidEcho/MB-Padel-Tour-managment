/**
 * The placement draws of a nations event (Cup, Plate, …) laid out as brackets:
 * one column per round, each split into its blocks ("Semi-finals", "5th–8th
 * play-offs"), and a "Winner of QF 1" line for a side that is not known yet.
 * Pure; shared with the app through `@core`.
 */
import type { MTie } from "../mobile/contract";

export interface BracketSide {
  teamId: string | null;
  /** "Winner QF 1" while the nation is not known yet; null once it is (or when nothing feeds it). */
  from: string | null;
}

export interface BracketTie {
  tie: MTie;
  /** "QF 1", "SF 2", "Final" — how other ties refer to this one. */
  ref: string;
  a: BracketSide;
  b: BracketSide;
}

export interface BracketBlock {
  name: string;
  ties: BracketTie[];
}

export interface BracketRound {
  roundNo: number;
  blocks: BracketBlock[];
}

export interface BracketDraw {
  key: string;
  /** "Cup", "Plate", or "Places 17–24" for a third draw. */
  name: string;
  /** "Places 1–8". */
  places: string | null;
  rounds: BracketRound[];
}

function shortName(round: string): string {
  if (round === "Quarter-finals") return "QF";
  if (round === "Semi-finals") return "SF";
  if (/^Round of \d+$/.test(round)) return `R${round.slice(9)}`;
  return round.replace(/ play-offs?$/, "").replace(/ place$/, "");
}

/** The placement ties of a nations event as brackets, the Cup first. Group ties are left out. */
export function placementBrackets(ties: MTie[]): BracketDraw[] {
  const placement = ties.filter((t) => t.stage === "placement").sort((x, y) => x.order - y.order);
  if (!placement.length) return [];

  const byDraw = new Map<string, MTie[]>();
  for (const t of placement) {
    const key = t.drawFrom != null ? `${t.drawFrom}-${t.drawTo ?? ""}` : "all";
    const list = byDraw.get(key) ?? [];
    list.push(t);
    byDraw.set(key, list);
  }
  const keys = [...byDraw.keys()].sort((x, y) => (parseInt(x, 10) || 0) - (parseInt(y, 10) || 0));

  // How every tie is referred to, e.g. "QF 2" or "5th–8th 1", numbered within its block.
  const ref = new Map<string, string>();
  for (const list of byDraw.values()) {
    const seen = new Map<string, number>();
    const counts = new Map<string, number>();
    for (const t of list) {
      const k = `${t.roundNo}|${t.roundName ?? ""}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    for (const t of list) {
      const k = `${t.roundNo}|${t.roundName ?? ""}`;
      const n = (seen.get(k) ?? 0) + 1;
      seen.set(k, n);
      const name = shortName(t.roundName ?? `Round ${t.roundNo}`);
      ref.set(t.id, counts.get(k) === 1 ? name : `${name} ${n}`);
    }
  }

  // The ties feeding each tie, in draw order: the first fills side A, the second side B.
  const feeders = new Map<string, string[]>();
  for (const t of placement) {
    if (t.winnerTo) feeders.set(t.winnerTo, [...(feeders.get(t.winnerTo) ?? []), `Winner ${ref.get(t.id)}`]);
    if (t.loserTo) feeders.set(t.loserTo, [...(feeders.get(t.loserTo) ?? []), `Loser ${ref.get(t.id)}`]);
  }

  return keys.map((key, i) => {
    const list = byDraw.get(key)!;
    const from = list[0].drawFrom;
    const to = list[0].drawTo;
    const name = key === "all" ? "Placement" : from === 1 ? "Cup" : keys.length === 2 || i === 1 ? "Plate" : `Places ${from}–${to}`;
    const rounds: BracketRound[] = [];
    for (const t of list) {
      let round = rounds.find((r) => r.roundNo === t.roundNo);
      if (!round) {
        round = { roundNo: t.roundNo, blocks: [] };
        rounds.push(round);
      }
      const blockName = t.roundName ?? `Round ${t.roundNo}`;
      let block = round.blocks.find((b) => b.name === blockName);
      if (!block) {
        block = { name: blockName, ties: [] };
        round.blocks.push(block);
      }
      const feed = feeders.get(t.id) ?? [];
      block.ties.push({
        tie: t,
        ref: ref.get(t.id)!,
        a: { teamId: t.a, from: t.a ? null : (feed[0] ?? null) },
        b: { teamId: t.b, from: t.b ? null : (feed[1] ?? null) },
      });
    }
    rounds.sort((x, y) => x.roundNo - y.roundNo);
    return { key, name, places: from != null && to != null ? `Places ${from}–${to}` : null, rounds };
  });
}

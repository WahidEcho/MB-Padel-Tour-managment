/**
 * The short line under a team on an entrance card: where they stand.
 *
 * What that means depends on what kind of match is starting:
 *
 *   group match      the team's place in its group: "2nd · 7 pts"
 *   knockout match   the path that brought them here: "SF · beat Falcons 6-4".
 *                    In the first knockout round there is no previous result, so
 *                    it falls back to how they finished their group — there is no
 *                    seed in the data to show instead.
 *   friendly match   the player's session ranking: "3rd · 12 pts"
 *
 * Returns null rather than inventing something when there is nothing honest to
 * say; the card keeps the chip's space so the layout does not jump.
 *
 * Pure and framework-free.
 */
import type { CompletedSet, Match, Standing, Stage } from "../types";
import { roundLabel } from "../bracket";

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

const KNOCKOUT: Stage[] = ["quarter_final", "semi_final", "final", "third_place", "knockout"];

export interface EntranceContext {
  standings: Pick<Standing, "team_id" | "group_id" | "rank" | "points">[];
  groupNames: Map<string, string>;
  matches: Pick<Match, "id" | "stage" | "status" | "bracket_id" | "round_name" | "team_a_id" | "team_b_id" | "winner_team_id" | "ended_at">[];
  completedSets: Map<string, CompletedSet[]>;
  teamNames: Map<string, string>;
}

function shortRound(roundName: string | null): string {
  if (!roundName) return "";
  // "Plate SF1" -> "Plate SF", "QF3" -> "QF"
  return roundName.replace(/\d+$/, "");
}

function scoreLine(sets: CompletedSet[] | undefined, winnerIsA: boolean): string {
  if (!sets?.length) return "";
  return sets
    .map((s) => (winnerIsA ? `${s.teamAGames}-${s.teamBGames}` : `${s.teamBGames}-${s.teamAGames}`))
    .join(" ");
}

export function entranceRankFor(
  match: Pick<Match, "id" | "stage" | "bracket_id" | "round_name" | "ended_at">,
  teamId: string,
  ctx: EntranceContext,
): string | null {
  if (match.stage === "group") {
    const row = ctx.standings.find((s) => s.team_id === teamId);
    if (!row) return null;
    return `${ordinal(row.rank)} · ${row.points} pts`;
  }

  if (KNOCKOUT.includes(match.stage)) {
    const round = shortRound(match.round_name);
    // Their most recent win in this same bracket, before this match.
    const previous = ctx.matches
      .filter(
        (m) =>
          m.id !== match.id &&
          m.bracket_id === match.bracket_id &&
          m.winner_team_id === teamId &&
          m.ended_at,
      )
      .sort((a, b) => Date.parse(b.ended_at!) - Date.parse(a.ended_at!))[0];

    if (previous) {
      const opponent = previous.team_a_id === teamId ? previous.team_b_id : previous.team_a_id;
      const name = opponent ? ctx.teamNames.get(opponent) : null;
      const score = scoreLine(ctx.completedSets.get(previous.id), previous.team_a_id === teamId);
      return [round, name ? `beat ${name} ${score}`.trim() : "won"].filter(Boolean).join(" · ");
    }

    // First knockout round: no previous result, so say how they got here.
    const row = ctx.standings.find((s) => s.team_id === teamId);
    if (row) {
      const group = ctx.groupNames.get(row.group_id);
      return `${round || roundLabel(match.stage)} · ${ordinal(row.rank)}${group ? ` in ${group}` : ""}`;
    }
    return round || null;
  }

  return null;
}

/** A friendly-session player's standing. */
export function sessionRankFor(rank: number | null | undefined, points: number | null | undefined): string | null {
  if (!rank) return null;
  return `${ordinal(rank)} · ${points ?? 0} pts`;
}

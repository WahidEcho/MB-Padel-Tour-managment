/**
 * National team coaches (migration 0037): the rules of what a coach sees. Pure (no
 * database, no Node or browser APIs), shared with the app through @core and tested on
 * their own (rules.test.ts). The server (server.ts) applies them to every row it serves.
 *
 * A coach's code names one team (a nation in one event). The coach reaches:
 *   - the ties and rubbers that team plays in (either side), nothing else;
 *   - their own team's line-up for each of them, once entered;
 *   - the opponents' players of a rubber only once that rubber is under way (the players
 *     are then on court for everyone to see); never another team's line-up before that;
 *   - the score and match log of their own rubbers, with no referee names;
 *   - their group's table (every team of the group, results only).
 * Anything else answers exactly like a missing row (404).
 */
import type { MScore } from "../mobile/contract";

/** The coach QR's path: https://tour.mbeg.org/c#<code> (the code in the #fragment never reaches a server). */
export const COACH_LINK_PATH = "/c";

export function coachLink(site: string, formattedCode: string): string {
  return `${site.replace(/\/+$/, "")}${COACH_LINK_PATH}#${encodeURIComponent(formattedCode)}`;
}

/** The code inside a coach link (https://…/c#CODE or movescore://c#CODE), as typed; null for anything else. */
export function parseCoachLink(data: string): string | null {
  const s = String(data ?? "").trim();
  if (!s || s.length > 300) return null;
  const m = /^(?:https?:\/\/[^/#?]+|movescore:\/\/)?\/?c\/?#([A-Za-z0-9-]{12,20})$/.exec(s);
  if (!m) return null;
  return decodeURIComponent(m[1]);
}

/** The label a team's code carries in the admin list and on its card: "Egypt · Davis Cup Juniors". */
export function coachCodeLabel(teamName: string, eventName: string): string {
  return `${teamName.trim()} · ${eventName.trim()}`.slice(0, 120);
}

export type CoachSide = "A" | "B";

/** Which side of a tie or match the coach's team is on; null when it is not in it. */
export function coachSideOf(teamId: string, row: { team_a_id: string | null; team_b_id: string | null }): CoachSide | null {
  if (!teamId) return null;
  if (row.team_a_id === teamId) return "A";
  if (row.team_b_id === teamId) return "B";
  return null;
}

/** A tie or match the coach may see: their team plays in it. */
export function coachReaches(teamId: string, row: { team_a_id: string | null; team_b_id: string | null } | null | undefined): boolean {
  return Boolean(row) && coachSideOf(teamId, row!) !== null;
}

const NOT_UNDER_WAY = new Set(["scheduled", "ready", "cancelled"]);

/**
 * Whether the opponents' players of a rubber are shown to the coach: only once the
 * rubber is under way (or over). Before that the opponents' line-up is another team's
 * line-up, and a coach never sees one.
 */
export function opponentsShown(rubberStatus: string): boolean {
  return !NOT_UNDER_WAY.has(rubberStatus);
}

/** A score with the coach's team first (`a` = us, `b` = them). */
export function orientScore(score: MScore | null, side: CoachSide): MScore | null {
  if (!score || side === "A") return score;
  const flip = <T extends { a: unknown; b: unknown }>(x: T): T => ({ ...x, a: x.b, b: x.a });
  return {
    ...score,
    sets: score.sets.map((s) => ({ ...flip(s), tb: s.tb ? flip(s.tb) : s.tb })),
    games: score.games ? flip(score.games) : null,
    points: score.points ? flip(score.points) : null,
    serving: score.serving ? (score.serving === "A" ? "B" : "A") : null,
    setsWon: flip(score.setsWon),
  };
}

/** "us" / "them" / null for a winner id seen from the coach's team. */
export function resultFor(teamId: string, winnerTeamId: string | null | undefined): "us" | "them" | null {
  if (!winnerTeamId) return null;
  return winnerTeamId === teamId ? "us" : "them";
}

/** A placement draw's name: the draw for places 1–8 is the Cup, any lower draw a Plate. */
export function drawLabel(drawFrom: number | null | undefined, drawTo: number | null | undefined): string | null {
  if (!drawFrom || !drawTo) return null;
  return `${drawFrom === 1 ? "Cup" : "Plate"} · places ${drawFrom}–${drawTo}`;
}

/** Where a tie sits: "Group A", "Cup · places 1–8 · Semi-final", "Plate · places 9–16 · Play-off 11–12". */
export function tieStageLabel(
  tie: { stage: "group" | "placement"; round_name: string | null; draw_from: number | null; draw_to: number | null; places_from: number | null; places_to: number | null },
  groupName: string | null,
): string {
  if (tie.stage === "group") return groupName ? `Group ${groupName.replace(/^group\s+/i, "")}` : "Group stage";
  const parts = [drawLabel(tie.draw_from, tie.draw_to) ?? "Placement", tie.round_name].filter(Boolean);
  return parts.join(" · ");
}

/** Where the team stands after the groups, from its standing status: the Cup, a Plate, or not decided yet. */
export function landingFrom(status: string | null | undefined, draws: { from: number; to: number }[]): string | null {
  if (status === "qualified") return draws.find((d) => d.from === 1) ? drawLabel(1, draws.find((d) => d.from === 1)!.to) : "Cup";
  if (status === "plate") {
    const lower = draws.filter((d) => d.from > 1).sort((a, b) => a.from - b.from)[0];
    return lower ? drawLabel(lower.from, lower.to) : "Plate";
  }
  return null;
}

/** The alert kinds a coach's phone gets (migration 0037), all about their own team. */
export const COACH_ALERT_KINDS = ["coach_soon", "coach_called", "coach_started", "coach_finished", "coach_tie_result", "coach_lineup"] as const;
export type CoachAlertKind = (typeof COACH_ALERT_KINDS)[number];

/** How long before a tie's time its coaches hear "starting in 5 minutes". */
export const COACH_SOON_MINUTES = 5;

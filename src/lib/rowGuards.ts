/**
 * Refusals for the tournament admin tools.
 *
 * A friendly session runs on a hidden `tournaments` row (`kind = 'friendly_session'`)
 * so the scoring stack, the screens and the control room serve it unchanged. The
 * tournament tools must not: its matches are stage 'friendly' history that feeds
 * the player ledger, fire streaks and ranking snapshots, and deleting the row
 * itself cascades into the session. Those tools refuse it here.
 *
 * A kind check on the tournament id a form posts is not enough on its own. Many
 * actions change a row by its own id — a match, a team, a group placement, a
 * standing — and a request can name a real tournament with a session's match id.
 * So the entity's own tournament is loaded and checked too.
 *
 * Server-only. Not placed inside the shared generators in ops.ts, which the
 * friendly-session code calls legitimately.
 */
import { db } from "./supabase";

export const NOT_A_TOURNAMENT_MESSAGE =
  "This is a friendly session's hidden tournament. Change its format, schedule and results from the session's own page — the tournament tools would delete its players' points.";

/** Tables whose rows carry the tournament they belong to. */
export type OwnedTable =
  | "matches"
  | "teams"
  | "players"
  | "courts"
  | "groups"
  | "group_teams"
  | "standings_snapshots"
  | "brackets"
  | "bracket_slots";

const NOUN: Record<OwnedTable, string> = {
  matches: "match",
  teams: "team",
  players: "player",
  courts: "court",
  groups: "group",
  group_teams: "group placement",
  standings_snapshots: "standing",
  brackets: "bracket",
  bracket_slots: "bracket slot",
};

/** Null when the tournament tools may change this row; otherwise why not. */
export async function tournamentRowRefusal(tournamentId: string): Promise<string | null> {
  if (!tournamentId) return "Tournament not found.";
  const { data } = await db().from("tournaments").select("kind").eq("id", tournamentId).maybeSingle();
  if (!data) return "Tournament not found.";
  return (data as { kind: string }).kind === "tournament" ? null : NOT_A_TOURNAMENT_MESSAGE;
}

/**
 * Null when every named row exists and belongs to `tournamentId`, without the
 * kind check — for the few actions sessions legitimately share, like releasing a
 * stuck scoring lock, which still must not reach into another tournament.
 */
export async function ownershipRefusal(
  tournamentId: string,
  table: OwnedTable,
  ids: string | string[],
): Promise<string | null> {
  const wanted = [...new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean))];
  if (wanted.length === 0) return `No ${NOUN[table]} was named.`;
  const { data } = await db().from(table).select("id, tournament_id").in("id", wanted);
  const rows = (data ?? []) as { id: string; tournament_id: string }[];
  if (rows.length !== wanted.length) {
    return `That ${NOUN[table]} no longer exists. Reload the page.`;
  }
  if (rows.some((r) => r.tournament_id !== tournamentId)) {
    return `That ${NOUN[table]} belongs to a different tournament.`;
  }
  return null;
}

/**
 * Null when the tournament tools may change these rows: the posted tournament is
 * a real tournament, and every row named belongs to it.
 */
export async function entityRefusal(
  tournamentId: string,
  table: OwnedTable,
  ids: string | string[],
): Promise<string | null> {
  return (await tournamentRowRefusal(tournamentId)) ?? (await ownershipRefusal(tournamentId, table, ids));
}

/**
 * For plain form actions: throws the refusal. These forms are not shown on a
 * session's row at all, so the throw is a backstop against a stale page or a
 * hand-made request rather than something an organiser meets.
 */
export function refuse(message: string | null): void {
  if (message) throw new Error(message);
}

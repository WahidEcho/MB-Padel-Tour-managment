/**
 * "Mine" on the Matches tab: the matches the signed-in person plays in (through
 * the player linked with their code) and the ones they starred. Followed players
 * and nations are the Following tab's business, not this one's.
 */
import type { MMatch, MMyPlayer } from "@core";

/**
 * Whether the linked player plays in `m`. Same rule as the server's own list
 * (`myMatches` in src/lib/players/claims.ts): in a team tie only the rubbers
 * they were nominated for; elsewhere every match of their team.
 */
export function playsIn(m: MMatch, me: Pick<MMyPlayer, "playerId" | "entries"> | null | undefined): boolean {
  if (!me) return false;
  const ids = new Set([me.playerId, ...me.entries.map((e) => e.playerId)]);
  const nominees = [...m.aPlayers, ...m.bPlayers];
  if (nominees.some((p) => ids.has(p))) return true;
  const teams = new Set(me.entries.map((e) => e.teamId));
  const ourTeam = Boolean((m.a && teams.has(m.a)) || (m.b && teams.has(m.b)));
  return ourTeam && (!m.tieId || nominees.length === 0);
}

export function isMine(m: MMatch, me: Pick<MMyPlayer, "playerId" | "entries"> | null | undefined, starred: string[]): boolean {
  return starred.includes(m.id) || playsIn(m, me);
}

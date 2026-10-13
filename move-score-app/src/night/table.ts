/**
 * A night's table on the phone (Phase 8): built from the bundle (courts, team
 * names, the night's settings) and the live feed's matches with the same
 * buildNightTable the web and the TV use, so the "about" times move as the
 * server re-estimates them after each match.
 */
import { buildNightTable, type MBundle, type MLive, type NightTable } from "@core";

export function nightTableOf(bundle: MBundle, live: MLive | undefined): NightTable | null {
  const night = bundle.tournament.night;
  if (!night) return null;
  const names = new Map(bundle.teams.map((t) => [t.id, t.name]));
  const matches = (live?.matches ?? [])
    .filter((m) => m.stage === "friendly" && !m.tieId)
    .map((m) => ({
      id: m.id,
      courtId: m.courtId,
      order: m.order,
      round: m.round,
      status: m.status,
      scheduledTime: m.scheduledTime,
      startedAt: m.startedAt,
      endedAt: m.endedAt,
      a: m.a ? (names.get(m.a) ?? null) : null,
      b: m.b ? (names.get(m.b) ?? null) : null,
      winner: m.winner ? (m.winner === m.a ? ("A" as const) : m.winner === m.b ? ("B" as const) : null) : null,
    }));
  if (!matches.length) return null;
  return buildNightTable(bundle.courts, matches, { timeZone: bundle.tournament.timezone, layout: night.layout });
}

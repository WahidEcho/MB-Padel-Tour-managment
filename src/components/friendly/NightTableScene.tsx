"use client";

import { useMemo } from "react";
import { useLive } from "@/components/broadcast/LiveFeedProvider";
import { buildNightTable } from "@/lib/friendly/nightTable";
import NightTableView from "./NightTableView";

/**
 * The TV's order of play for a night (a session's screen on the bracket scene):
 * built on the wall from the live feed every poll, so the "about" times move as
 * matches start and finish without a server render. Team names only.
 */
export default function NightTableScene({
  courts,
  teamNames,
  timeZone,
}: {
  courts: { id: string; name: string; order: number }[];
  teamNames: Record<string, string>;
  timeZone: string;
}) {
  const { feed } = useLive();
  const table = useMemo(() => {
    const matches = (feed?.matches ?? [])
      .filter((m) => m.stage === "friendly")
      .map((m) => ({
        id: m.id,
        courtId: m.court_id,
        order: m.match_order,
        round: m.round_name,
        status: m.status,
        scheduledTime: m.scheduled_time,
        startedAt: m.started_at,
        endedAt: m.ended_at,
        a: m.team_a_id ? (teamNames[m.team_a_id] ?? null) : null,
        b: m.team_b_id ? (teamNames[m.team_b_id] ?? null) : null,
        winner: m.winner_team_id ? (m.winner_team_id === m.team_a_id ? ("A" as const) : m.winner_team_id === m.team_b_id ? ("B" as const) : null) : null,
      }));
    return buildNightTable(courts, matches, { timeZone });
  }, [feed, courts, teamNames, timeZone]);

  if (table.matches === 0) {
    return <p className="flex h-full items-center justify-center text-[40px] text-muted">The order of play is not out yet</p>;
  }
  return <NightTableView table={table} variant="tv" limitPerCourt={4} />;
}

"use server";

import { requirePermission } from "@/lib/guard";
import { refuse, tournamentRowRefusal } from "@/lib/rowGuards";
import { db } from "@/lib/supabase";
import type { ScoreState } from "@/lib/scoring/engine";

export interface RubberProgress {
  id: string;
  status: string;
  lastEventNumber: number;
  state: ScoreState | null;
}

/**
 * Where each rubber stands, for the replay console to start or pick up from.
 * Demo events only: a replay writes results nobody played.
 */
export async function replayProgressAction(tournamentId: string, matchIds: string[]): Promise<RubberProgress[]> {
  await requirePermission("score_match");
  refuse(await tournamentRowRefusal(tournamentId));
  const { data: t } = await db().from("tournaments").select("is_demo").eq("id", tournamentId).single();
  if (!t?.is_demo) throw new Error("Replays are for demo events only.");
  const [{ data: matches }, { data: snaps }] = await Promise.all([
    db().from("matches").select("id, status").eq("tournament_id", tournamentId).in("id", matchIds),
    db().from("match_score_snapshots").select("match_id, last_event_number, snapshot_json").eq("tournament_id", tournamentId).in("match_id", matchIds),
  ]);
  const snapBy = new Map((snaps ?? []).map((s) => [s.match_id as string, s]));
  return (matches ?? []).map((m) => {
    const s = snapBy.get(m.id as string);
    const json = (s?.snapshot_json ?? null) as ScoreState | null;
    return {
      id: m.id as string,
      status: m.status as string,
      lastEventNumber: (s?.last_event_number as number | undefined) ?? 0,
      state: json && "teamA" in json ? json : null,
    };
  });
}

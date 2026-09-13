import { db } from "../supabase";
import type { Match, MatchSnapshot, ScreenSettings } from "../types";
import { toLiveMatch, toLiveSnapshot, type LiveFeed } from "./liveFeed";

/**
 * Builds the live feed for one screen. Used by the polling endpoint and by the
 * screen's first server render, so the first frame and every poll after it are
 * the same shape from the same code.
 */
export async function buildLiveFeed(tournamentId: string, screen: ScreenSettings): Promise<LiveFeed> {
  const [{ data: matches }, { data: snapshots }] = await Promise.all([
    db().from("matches").select("*").eq("tournament_id", tournamentId),
    db().from("match_score_snapshots").select("*").eq("tournament_id", tournamentId),
  ]);
  return {
    // Stamped after the queries return, so the clock anchor is not early by the
    // query latency — which is about the length of a point beat.
    fetchedAt: Date.now(),
    screen: {
      revision: screen.revision,
      display_mode: screen.display_mode,
      court_ids: screen.court_ids,
      focus_court_id: screen.focus_court_id,
      focus_match_id: screen.focus_match_id,
      bracket_tier: screen.bracket_tier,
      mute_animations: screen.mute_animations,
      break_started_at: screen.break_started_at,
      break_ends_at: screen.break_ends_at,
      ceremony_step: screen.ceremony_step,
      ceremony_step_at: screen.ceremony_step_at,
      entrance_replay: screen.entrance_replay,
      theme: screen.theme,
    },
    matches: ((matches ?? []) as Match[]).filter((m) => m.status !== "cancelled").map(toLiveMatch),
    snapshots: ((snapshots ?? []) as MatchSnapshot[]).map(toLiveSnapshot),
  };
}

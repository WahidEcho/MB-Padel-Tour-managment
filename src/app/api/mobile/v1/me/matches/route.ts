import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { ownerOf } from "@/lib/mobile/identity";
import { privateJson } from "@/lib/mobile/http";
import { toMatch } from "@/lib/mobile/projection";
import type { Match } from "@/lib/types";
import { audienceMatches } from "@/lib/live/delayServer";

/** My Matches: every match of the players this account has claimed, soonest first. */
export async function GET(request: Request) {
  const { owner } = await ownerOf(request);
  if (owner?.kind !== "user") return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  // Two plain reads: player_claims references players twice (player_id, via_player_id), so an embed
  // is ambiguous (PostgREST refuses it, PGRST201) and used to answer with no players at all.
  const { data: claims } = await db().from("player_claims").select("player_id").eq("user_id", owner.id);
  const claimed = ((claims ?? []) as { player_id: string }[]).map((c) => c.player_id);
  const { data: rows } = claimed.length ? await db().from("players").select("id, full_name, team_id, tournament_id").in("id", claimed) : { data: [] };
  const players = (rows ?? []) as { id: string; full_name: string; team_id: string; tournament_id: string }[];
  if (!players.length) return privateJson({ players: [], matches: [] });
  const teamIds = [...new Set(players.map((p) => p.team_id))];
  const { data: ms } = await db()
    .from("matches")
    .select("*")
    .or(teamIds.map((t) => `team_a_id.eq.${t},team_b_id.eq.${t}`).join(","))
    .order("scheduled_time", { ascending: true, nullsFirst: false });
  const ids = new Set(players.map((p) => p.id));
  const mine = ((ms ?? []) as Match[]).filter((m) => {
    if (!m.tie_id) return true;
    const nominees = [...(m.team_a_player_ids ?? []), ...(m.team_b_player_ids ?? [])];
    return nominees.length === 0 || nominees.some((n) => ids.has(n));
  });
  // The audience delay of each event: a player's own list shows results when the fans see them.
  const seen = await audienceMatches(mine, []);
  return privateJson({ players, matches: seen.matches.map((m) => toMatch(m, null)) });
}

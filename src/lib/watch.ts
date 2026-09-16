import { db } from "./supabase";
import { courtsForScreen, getCourts, listScreens } from "./data";
import { MAIN_SCREEN } from "./screens";
import { normalizeDisplayMode, type DisplayMode } from "./types";
import type { WatchableCourt, WatchableScreen } from "@/components/WatchOnScreenMenu";

/** What a spectator is told a screen is showing. Plain words, not the operator's. */
const SHOWING: Record<Exclude<DisplayMode, "live_court" | "all_live">, string> = {
  live: "Live scores",
  leaderboard: "Leaderboard",
  bracket: "Knockout bracket",
  winner: "Winners",
  ceremony: "Prize ceremony",
  sponsors: "Our partners",
  holding: "Between matches",
};

function join(names: string[]): string {
  if (names.length === 0) return "Every court";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The venue screens and courts a public visitor may open.
 *
 * Nothing here is privileged: a screen's URL is already public, and this only
 * saves a spectator having to be told it. Team names are the public ones shown
 * on every other page; no phone number or note is read.
 */
export async function watchTargets(
  tournamentId: string,
): Promise<{ screens: WatchableScreen[]; courts: WatchableCourt[] }> {
  const [stored, courts] = await Promise.all([listScreens(tournamentId), getCourts(tournamentId)]);

  // A tournament that has never opened the control room has no rows at all, and
  // its main screen still works — so it is always offered.
  const screens = stored.length > 0 ? stored : [];
  const rows: WatchableScreen[] = screens.map((s) => ({
    key: s.screen_key,
    name: s.screen_name?.trim() || (s.screen_key === MAIN_SCREEN ? "Main screen" : s.screen_key),
    showing: SHOWING[normalizeDisplayMode(s.display_mode)],
    covers: join(courtsForScreen(s, courts).map((c) => c.court_name)),
  }));
  if (!rows.some((r) => r.key === MAIN_SCREEN)) {
    rows.unshift({ key: MAIN_SCREEN, name: "Main screen", showing: "Live scores", covers: "Every court" });
  }

  // One light query rather than the whole schedule: a public page renders this
  // menu on every request.
  const { data: live } = await db()
    .from("matches")
    .select("court_id, team_a:team_a_id (team_name), team_b:team_b_id (team_name)")
    .eq("tournament_id", tournamentId)
    .in("status", ["live", "paused"]);
  type Row = { court_id: string | null; team_a: { team_name: string } | null; team_b: { team_name: string } | null };
  const playing = new Map<string, string>();
  for (const m of (live ?? []) as unknown as Row[]) {
    if (!m.court_id || playing.has(m.court_id)) continue;
    playing.set(m.court_id, `${m.team_a?.team_name ?? "TBD"} v ${m.team_b?.team_name ?? "TBD"}`);
  }

  return {
    screens: rows,
    courts: courts.map((c) => ({ name: c.court_name, playing: playing.get(c.id) ?? null })),
  };
}

import { db } from "./supabase";
import type {
  Bracket,
  BracketSlot,
  Court,
  Group,
  GroupTeam,
  Match,
  MatchSnapshot,
  ScreenSettings,
  Standing,
  Team,
  Tournament,
} from "./types";

export async function getTournament(id: string): Promise<Tournament | null> {
  const { data } = await db().from("tournaments").select("*").eq("id", id).maybeSingle();
  return data as Tournament | null;
}

export async function getTournamentBySlug(slug: string): Promise<Tournament | null> {
  const { data } = await db().from("tournaments").select("*").eq("slug", slug).maybeSingle();
  return data as Tournament | null;
}

export async function getTeams(tournamentId: string): Promise<Team[]> {
  const { data } = await db()
    .from("teams")
    .select("*, players(*)")
    .eq("tournament_id", tournamentId)
    .order("team_name");
  const teams = (data ?? []) as Team[];
  for (const t of teams) t.players?.sort((a, b) => a.player_order - b.player_order);
  return teams;
}

export async function getCourts(tournamentId: string): Promise<Court[]> {
  const { data } = await db()
    .from("courts")
    .select("*")
    .eq("tournament_id", tournamentId)
    .order("court_order");
  return (data ?? []) as Court[];
}

export async function getGroups(tournamentId: string): Promise<Group[]> {
  const { data } = await db()
    .from("groups")
    .select("*")
    .eq("tournament_id", tournamentId)
    .order("group_order");
  return (data ?? []) as Group[];
}

export async function getGroupTeams(tournamentId: string): Promise<GroupTeam[]> {
  const { data } = await db()
    .from("group_teams")
    .select("*")
    .eq("tournament_id", tournamentId)
    .order("position");
  return (data ?? []) as GroupTeam[];
}

export async function getMatches(tournamentId: string): Promise<Match[]> {
  const { data } = await db()
    .from("matches")
    .select("*")
    .eq("tournament_id", tournamentId)
    .order("match_order");
  return (data ?? []) as Match[];
}

export async function getMatch(matchId: string): Promise<Match | null> {
  const { data } = await db().from("matches").select("*").eq("id", matchId).maybeSingle();
  return data as Match | null;
}

export async function getSnapshots(tournamentId: string): Promise<MatchSnapshot[]> {
  const { data } = await db()
    .from("match_score_snapshots")
    .select("*")
    .eq("tournament_id", tournamentId);
  return (data ?? []) as MatchSnapshot[];
}

export async function getSnapshot(matchId: string): Promise<MatchSnapshot | null> {
  const { data } = await db()
    .from("match_score_snapshots")
    .select("*")
    .eq("match_id", matchId)
    .maybeSingle();
  return data as MatchSnapshot | null;
}

export async function getStandings(tournamentId: string): Promise<Standing[]> {
  const { data } = await db()
    .from("standings_snapshots")
    .select("*")
    .eq("tournament_id", tournamentId)
    .order("rank");
  return (data ?? []) as Standing[];
}

export async function getBracket(tournamentId: string): Promise<Bracket | null> {
  const { data } = await db()
    .from("brackets")
    .select("*")
    .eq("tournament_id", tournamentId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data as Bracket | null;
}

export async function getBracketSlots(bracketId: string): Promise<BracketSlot[]> {
  const { data } = await db()
    .from("bracket_slots")
    .select("*")
    .eq("bracket_id", bracketId)
    .order("slot_order");
  return (data ?? []) as BracketSlot[];
}

export async function getScreenSettings(tournamentId: string): Promise<ScreenSettings> {
  const { data } = await db()
    .from("screen_settings")
    .select("*")
    .eq("tournament_id", tournamentId)
    .eq("screen_key", "main")
    .maybeSingle();
  if (data) return data as ScreenSettings;
  const { data: created } = await db()
    .from("screen_settings")
    .insert({ tournament_id: tournamentId, screen_key: "main" })
    .select()
    .single();
  return created as ScreenSettings;
}

export function teamMap(teams: Team[]): Map<string, Team> {
  return new Map(teams.map((t) => [t.id, t]));
}

/**
 * The public facts a court's broadcast overlay is rendered with. Server only.
 *
 * Everything here is serialised into the page (the overlay is a client
 * component), so it is built field by field: nation or team names and codes,
 * players' names, nominees, rules and the ties on the court. Never a phone,
 * email, access code, note or photo — the score bug has no use for them.
 */
import { db } from "../supabase";
import { getCourts, getMatches, getTeams, getTournamentBySlug } from "../data";
import { getTies, isTieFormat } from "../tennis/tieOps";
import { EVENT_TIME_ZONE } from "../tennis/ties";
import { isDoublesMatch, scoringConfigForMatch } from "../scoring/rules";
import { matchDayRules } from "../matchday/rules";
import { resolveSponsors, sponsorStyle } from "../sponsors";
import { shortCode } from "../mobile/projection";
import type { Court, Tournament } from "../types";
import { liveVideoConfig } from "./liveVideo";
import { resolveCourtParam, type OverlayMatchInfo, type OverlaySwitches, type OverlayTeam, type OverlayTie } from "./overlay";

export interface OverlayLogo {
  name: string;
  logoUrl: string;
  aspect?: number;
}

export interface OverlayProps {
  slug: string;
  court: { id: string; name: string };
  title: string;
  timeZone: string;
  teams: Record<string, OverlayTeam>;
  ties: OverlayTie[];
  info: Record<string, OverlayMatchInfo>;
  switches: OverlaySwitches;
  /** Every sponsor, main partner first: the footer loops them all. */
  sponsors: OverlayLogo[];
  chips: boolean;
  uniform: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A court id copied from a sibling tournament of the same event (an event group
 * shares its venue and its court codes): the slug that court belongs to, so the
 * link is sent there instead of a blank 404 in the OBS scene. Only to another
 * public tournament of the same group.
 */
async function siblingCourtSlug(tournament: Tournament, courtParam: string): Promise<string | null> {
  const id = decodeURIComponent(courtParam).trim();
  if (!UUID.test(id) || !tournament.event_group_id) return null;
  const { data: court } = await db().from("courts").select("id, tournament_id").eq("id", id).maybeSingle();
  const owner = court as { id: string; tournament_id: string } | null;
  if (!owner || owner.tournament_id === tournament.id) return null;
  const { data: other } = await db()
    .from("tournaments")
    .select("slug, event_group_id, public_access_enabled, kind")
    .eq("id", owner.tournament_id)
    .maybeSingle();
  const t = other as { slug: string; event_group_id: string | null; public_access_enabled: boolean; kind: string } | null;
  return t && t.public_access_enabled && t.kind === "tournament" && t.event_group_id === tournament.event_group_id ? t.slug : null;
}

export type OverlayData = { tournament: Tournament; props: OverlayProps } | { redirect: string } | null;

export async function overlayData(slug: string, courtParam: string): Promise<OverlayData> {
  const tournament = await getTournamentBySlug(slug);
  if (!tournament || !tournament.public_access_enabled || tournament.kind !== "tournament") return null;
  const courts: Court[] = await getCourts(tournament.id);
  const court = resolveCourtParam(courts, courtParam);
  if (!court) {
    const home = await siblingCourtSlug(tournament, courtParam);
    return home ? { redirect: `/t/${encodeURIComponent(home)}/overlay/${encodeURIComponent(decodeURIComponent(courtParam).trim())}` } : null;
  }

  const [teams, matches, ties] = await Promise.all([
    getTeams(tournament.id),
    getMatches(tournament.id),
    isTieFormat(tournament) ? getTies(tournament.id) : Promise.resolve([]),
  ]);

  const overlayTeams: Record<string, OverlayTeam> = {};
  for (const t of teams) {
    overlayTeams[t.id] = {
      id: t.id,
      code: t.nation_code || shortCode(t.team_name),
      iso2: t.iso2 ?? null,
      name: t.team_name,
      players: (t.players ?? []).map((p) => ({ id: p.id, name: p.full_name })),
    };
  }

  const info: Record<string, OverlayMatchInfo> = {};
  for (const m of matches) {
    if (m.status === "cancelled") continue;
    // Doubles as the referee console decides it (append.ts): the rubber's type, else two players a side.
    const pair = (id: string | null) => teams.find((t) => t.id === id);
    const doubles = m.rubber_type ? m.rubber_type === "D" : isDoublesMatch(pair(m.team_a_id), pair(m.team_b_id));
    const r = scoringConfigForMatch(tournament, m, null, { doubles });
    info[m.id] = {
      id: m.id,
      tie_id: m.tie_id ?? null,
      rubber_no: m.rubber_no ?? null,
      rubber_type: m.rubber_type ?? null,
      a: (m.team_a_player_ids as string[] | null | undefined) ?? [],
      b: (m.team_b_player_ids as string[] | null | undefined) ?? [],
      round_name: m.round_name,
      rules: {
        setsToWinMatch: r.setsToWinMatch,
        gamesToWinSet: r.gamesToWinSet,
        tiebreakEnabled: r.tiebreakEnabled,
        tiebreakAtGames: r.tiebreakAtGames,
        tiebreakTargetPoints: r.tiebreakTargetPoints,
        tiebreakWinByTwo: r.tiebreakWinByTwo,
        decidingPoint: r.decidingPoint,
        matchTiebreak: r.matchTiebreak,
        matchTiebreakPoints: r.matchTiebreakPoints,
        walkoverScore: r.walkoverScore,
      },
    };
  }

  const features = matchDayRules(tournament.match_day_rules, tournament).features;
  const { main, footer } = resolveSponsors(tournament.branding_config);
  const style = sponsorStyle(tournament.branding_config);
  const cfg = liveVideoConfig(tournament.branding_config);

  return {
    tournament,
    props: {
      slug,
      court: { id: court.id, name: court.court_name },
      title: cfg.overlayTitle || tournament.name,
      timeZone: tournament.timezone || EVENT_TIME_ZONE,
      teams: overlayTeams,
      ties: ties.map((t) => ({ id: t.id, court_id: t.court_id, tie_order: t.tie_order, team_a_id: t.team_a_id, team_b_id: t.team_b_id, round_name: t.round_name })),
      info,
      switches: { aces: features.tvAces && features.ace, timers: features.tvTimers },
      sponsors: [
        ...(main ? [{ name: main.name, logoUrl: main.logoUrl, ...(main.aspect ? { aspect: main.aspect } : {}) }] : []),
        ...footer.map((s) => ({ name: s.name, logoUrl: s.logoUrl, ...(s.aspect ? { aspect: s.aspect } : {}) })),
      ],
      chips: style.chips,
      uniform: style.uniform,
    },
  };
}

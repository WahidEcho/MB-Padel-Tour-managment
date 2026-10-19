/**
 * The public facts a court's broadcast overlay is rendered with. Server only.
 *
 * Everything here is serialised into the page (the overlay is a client
 * component), so it is built field by field: nation or team names and codes,
 * players' names, nominees, rules and the ties on the court. Never a phone,
 * email, access code, note or photo — the score bug has no use for them.
 */
import { getCourts, getMatches, getTeams, getTournamentBySlug } from "../data";
import { getTies, isTieFormat } from "../tennis/tieOps";
import { EVENT_TIME_ZONE } from "../tennis/ties";
import { scoringConfigForMatch } from "../scoring/rules";
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

export async function overlayData(slug: string, courtParam: string): Promise<{ tournament: Tournament; props: OverlayProps } | null> {
  const tournament = await getTournamentBySlug(slug);
  if (!tournament || !tournament.public_access_enabled || tournament.kind !== "tournament") return null;
  const courts: Court[] = await getCourts(tournament.id);
  const court = resolveCourtParam(courts, courtParam);
  if (!court) return null;

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
    const r = scoringConfigForMatch(tournament, m, null, m.rubber_type ? { doubles: m.rubber_type === "D" } : undefined);
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

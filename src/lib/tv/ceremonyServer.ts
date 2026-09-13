import { podiumDepthFor } from "../bracket";
import { getBrackets, getMatches, getTeams, teamMap } from "../data";
import { getRankingSnapshot, getSessionByTournament, listPublicPlayers } from "../friendly/data";
import { toPublicTeam } from "../public";
import type { BracketTier, ScreenSettings, Tournament } from "../types";
import { podiumFromMatches } from "../../components/WinnerDisplay";
import { ceremonySteps, sessionCeremonyTier, type CeremonyPerson, type CeremonyTier } from "./ceremony";

/**
 * The ceremony a screen would run right now: its tiers, in reveal order.
 *
 * A tournament's comes from its published brackets — the Plate before the Cup
 * when the screen shows both — each at its configured podium depth. A friendly
 * session's comes from its ranking, where ties share a place. Only public
 * projections leave this function: the ceremony stage is a client component.
 */
export async function buildCeremony(
  tournament: Tournament,
  screen: Pick<ScreenSettings, "bracket_tier">,
): Promise<CeremonyTier[]> {
  if (tournament.kind === "friendly_session") {
    const session = await getSessionByTournament(tournament.id);
    if (!session) return [];
    const ranking = await getRankingSnapshot("session", session.id);
    const players = await listPublicPlayers(ranking.map((r) => r.player_profile_id));
    const people = new Map<string, CeremonyPerson>(
      [...players.values()].map((p) => [
        p.id,
        { id: p.id, name: p.public_name, photo_url: p.photo_url, portrait_url: p.portrait_url, focal_x: p.focal_x, focal_y: p.focal_y },
      ]),
    );
    const depth = tournament.format_config?.tiers?.cup?.podiumDepth ?? 3;
    return [sessionCeremonyTier(session.name, ranking, people, depth)];
  }

  const [brackets, matches, teams] = await Promise.all([
    getBrackets(tournament.id),
    getMatches(tournament.id),
    getTeams(tournament.id),
  ]);
  const published = brackets.filter((b) => b.status === "published");
  // Minor trophies first, as real ceremonies do: the Cup is saved for the end.
  const order: BracketTier[] =
    screen.bracket_tier === "both" ? ["plate", "cup"] : screen.bracket_tier === "plate" ? ["plate"] : ["cup"];
  const tm = teamMap(teams);
  const twoTiers = published.length > 1 && order.length > 1;

  return order.flatMap((tier) => {
    const bracket = published.find((b) => b.tier === tier);
    if (!bracket) return [];
    const depth = podiumDepthFor(tournament.format_config, tier);
    const podium = podiumFromMatches(matches, tm, { tier, bracketId: bracket.id, depth });
    return [
      {
        key: tier,
        label: twoTiers || tier === "plate" ? (tier === "plate" ? "Plate" : "Cup") : tournament.name,
        configuredDepth: depth,
        places: podium.places
          .filter((p) => p.team)
          .map((p) => {
            const team = toPublicTeam(p.team!);
            return {
              place: p.place,
              entrants: [
                {
                  title: team.team_name,
                  people: team.players.map((pl) => ({
                    id: pl.id,
                    name: pl.full_name,
                    photo_url: pl.photo_url,
                    portrait_url: pl.portrait_url,
                    focal_x: pl.focal_x,
                    focal_y: pl.focal_y,
                  })),
                },
              ],
            };
          }),
      },
    ];
  });
}

/** The index of the last step a screen's ceremony has, for clamping NEXT PLACE. */
export async function ceremonyLastStep(tournament: Tournament, screen: Pick<ScreenSettings, "bracket_tier">): Promise<number> {
  return Math.max(0, ceremonySteps(await buildCeremony(tournament, screen)).length - 1);
}

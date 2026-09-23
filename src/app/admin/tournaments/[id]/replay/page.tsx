import { getCourts, getMatches, getTeams, getTournament } from "@/lib/data";
import { scoringConfigForMatch } from "@/lib/scoring/rules";
import { RUBBER_LABELS } from "@/lib/tennis/ties";
import { getTies, isTieFormat } from "@/lib/tennis/tieOps";
import type { Team } from "@/lib/types";
import SessionRowNotice from "../SessionRowNotice";
import ReplayConsole, { type ReplayTie } from "./ReplayConsole";

export const dynamic = "force-dynamic";

/**
 * Plays known results back onto the courts, point by point, through the same
 * events a referee's phone sends — so the TVs, walk-ons and callouts can be
 * reviewed with real finals. Demo events only.
 */
export default async function ReplayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tournament = await getTournament(id);
  if (!tournament) return null;
  if (tournament.kind !== "tournament") return <SessionRowNotice tournamentId={id} tool="Replay" />;
  if (!isTieFormat(tournament)) return <p className="text-sm text-muted">Replays are for team competitions.</p>;
  if (!tournament.is_demo) {
    return (
      <p className="text-sm text-muted">
        Replays write results nobody played, so they are only for demo events. This event is not marked as a demo.
      </p>
    );
  }
  const [ties, matches, teams, courts] = await Promise.all([getTies(id), getMatches(id), getTeams(id), getCourts(id)]);
  const teamBy = new Map(teams.map((t) => [t.id, t]));
  const courtBy = new Map(courts.map((c) => [c.id, c.court_name]));
  const lines = tournament.format_config?.ties?.replays ?? {};
  const surnames = (team: Team | undefined, ids: string[] | null | undefined) =>
    (ids ?? []).map((pid) => team?.players?.find((p) => p.id === pid)?.full_name.split(" ").slice(-1)[0] ?? "?").join(" / ");

  const shown: ReplayTie[] = ties
    .sort((a, b) => a.tie_order - b.tie_order)
    .map((tie) => {
      const a = tie.team_a_id ? teamBy.get(tie.team_a_id) : undefined;
      const b = tie.team_b_id ? teamBy.get(tie.team_b_id) : undefined;
      return {
        id: tie.id,
        title: `${a?.nation_code ?? a?.team_name ?? "TBD"} v ${b?.nation_code ?? b?.team_name ?? "TBD"}`,
        where: [tie.court_id ? courtBy.get(tie.court_id) : null, tie.round_name].filter(Boolean).join(" · "),
        rubbers: matches
          .filter((m) => m.tie_id === tie.id)
          .sort((x, y) => (x.rubber_no ?? 0) - (y.rubber_no ?? 0))
          .map((m) => ({
            id: m.id,
            label: `${m.rubber_type ? RUBBER_LABELS[m.rubber_type] : "Rubber"} · ${surnames(a, m.team_a_player_ids) || a?.team_name} v ${surnames(b, m.team_b_player_ids) || b?.team_name}`,
            teamA: m.team_a_id,
            teamB: m.team_b_id,
            line: lines[m.id] ?? "",
            rules: scoringConfigForMatch(tournament, m, null, { doubles: m.rubber_type === "D" }),
          })),
      };
    })
    .filter((t) => t.rubbers.length > 0);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold">Replay results</h2>
        <p className="text-sm text-muted">
          Plays a known result back onto its court, point by point, as a referee&apos;s phone would score it. The court TV
          shows the walk-ons, the live score and its callouts, the rubber won and the tie score. Only the set scores are
          real; the points inside them are made up to fit. Keep this page open while it plays; it picks up where it left
          off if reloaded.
        </p>
      </div>
      <ReplayConsole tournamentId={id} ties={shown} />
    </div>
  );
}

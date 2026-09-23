import { getGroups, getMatches, getSnapshots, getTeams, getTournament } from "@/lib/data";
import { scoreSummary, type ScoreState } from "@/lib/scoring/engine";
import { RUBBER_LABELS } from "@/lib/tennis/ties";
import { finalPlacings, getTies, isTieFormat } from "@/lib/tennis/tieOps";
import { ordinal } from "@/lib/tennis/placement";
import type { Match, RubberType, Team, Tie } from "@/lib/types";
import SessionRowNotice from "../SessionRowNotice";
import { generateTiesAction } from "./actions";
import { LineupForm, LockForm, PlacementControls } from "./TieForms";

export const dynamic = "force-dynamic";

const STATUS: Record<Tie["status"], [string, string]> = {
  scheduled: ["Scheduled", "bg-border text-muted"],
  live: ["Live", "bg-accent/15 text-accent"],
  completed: ["Final", "bg-success/15 text-success"],
};

export default async function TiesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tournament = await getTournament(id);
  if (!tournament) return null;
  if (tournament.kind !== "tournament") return <SessionRowNotice tournamentId={id} tool="Ties" />;
  if (!isTieFormat(tournament)) {
    return <p className="text-sm text-muted">This tournament is not a team competition, so it has no ties.</p>;
  }
  const [ties, teams, matches, snapshots, groups, placings] = await Promise.all([
    getTies(id),
    getTeams(id),
    getMatches(id),
    getSnapshots(id),
    getGroups(id),
    finalPlacings(id),
  ]);
  const teamBy = new Map(teams.map((t) => [t.id, t]));
  const snapBy = new Map(snapshots.map((s) => [s.match_id, s]));
  const rubbersOf = (tieId: string) => matches.filter((m) => m.tie_id === tieId).sort((a, b) => (a.rubber_no ?? 0) - (b.rubber_no ?? 0));
  const playerName = (team: Team | undefined, pid: string) => team?.players?.find((p) => p.id === pid)?.full_name ?? "?";
  const groupTies = ties.filter((t) => t.stage === "group");
  const placementTies = ties.filter((t) => t.stage === "placement");
  const groupsDone = groupTies.length > 0 && groupTies.every((t) => t.status === "completed");

  const tieCard = (tie: Tie) => {
    const a = tie.team_a_id ? teamBy.get(tie.team_a_id) : undefined;
    const b = tie.team_b_id ? teamBy.get(tie.team_b_id) : undefined;
    const rubbers = rubbersOf(tie.id);
    const started = rubbers.some((r) => !["scheduled", "ready", "cancelled"].includes(r.status));
    const lineup = (field: "team_a_player_ids" | "team_b_player_ids") => {
      const of = (type: RubberType) => rubbers.find((r) => r.rubber_type === type)?.[field] ?? null;
      return { S1: of("S1")?.[0] ?? null, S2: of("S2")?.[0] ?? null, D: of("D") ?? [] };
    };
    const [label, cls] = STATUS[tie.status];
    return (
      <div key={tie.id} className="card space-y-3" data-testid="tie-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">{tie.round_name}</span>
            {tie.places_from && <span className="badge bg-card text-muted">for {ordinal(tie.places_from)}</span>}
          </div>
          <span className={`badge ${cls}`}>{label}</span>
        </div>
        <div className="flex items-center justify-between gap-2 text-lg font-bold">
          <span className={tie.winner_team_id && tie.winner_team_id === a?.id ? "text-success" : ""}>{a ? `${a.nation_code ?? ""} ${a.team_name}` : "To be decided"}</span>
          <span className="font-mono tabular-nums">{tie.rubbers_a} – {tie.rubbers_b}</span>
          <span className={`text-right ${tie.winner_team_id && tie.winner_team_id === b?.id ? "text-success" : ""}`}>{b ? `${b.team_name} ${b.nation_code ?? ""}` : "To be decided"}</span>
        </div>
        <ul className="space-y-1 text-sm">
          {rubbers.map((r: Match) => {
            const snap = snapBy.get(r.id);
            const score = snap?.snapshot_json ? scoreSummary(snap.snapshot_json as unknown as ScoreState) : "";
            const side = (ids: string[] | null | undefined, team: Team | undefined) =>
              ids?.length ? ids.map((pid) => playerName(team, pid).split(" ").slice(-1)[0]).join(" / ") : "—";
            return (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-1">
                <span className="w-28 text-xs font-semibold text-muted">{RUBBER_LABELS[r.rubber_type as RubberType]}</span>
                <span className="flex-1">
                  {side(r.team_a_player_ids, a)} <span className="text-muted">v</span> {side(r.team_b_player_ids, b)}
                </span>
                <span className="font-mono text-xs tabular-nums">{r.status === "cancelled" ? "not played" : score || r.status}</span>
              </li>
            );
          })}
        </ul>
        {a && b && (
          <details>
            <summary className="cursor-pointer text-xs font-semibold text-muted">
              Line-ups {tie.lineup_locked_at ? "· locked" : "· open"}
            </summary>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <LineupForm
                tournamentId={id}
                tieId={tie.id}
                side="A"
                nation={a.team_name}
                squad={(a.players ?? []).map((p) => ({ id: p.id, name: p.full_name }))}
                current={lineup("team_a_player_ids")}
                locked={Boolean(tie.lineup_locked_at)}
                started={tie.status === "completed"}
              />
              <LineupForm
                tournamentId={id}
                tieId={tie.id}
                side="B"
                nation={b.team_name}
                squad={(b.players ?? []).map((p) => ({ id: p.id, name: p.full_name }))}
                current={lineup("team_b_player_ids")}
                locked={Boolean(tie.lineup_locked_at)}
                started={tie.status === "completed"}
              />
            </div>
            {!tie.lineup_locked_at && !started && <div className="mt-2"><LockForm tournamentId={id} tieId={tie.id} /></div>}
          </details>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold">Ties ({ties.length})</h2>
        {groupTies.length === 0 && (
          <form action={generateTiesAction}>
            <input type="hidden" name="tournament_id" value={id} />
            <button type="submit" className="btn-primary" disabled={groups.length === 0}>Generate the group ties</button>
          </form>
        )}
      </div>
      {groups.length === 0 && <p className="text-sm text-muted">Draw the nations into groups first, on the Groups page.</p>}

      {groups.map((g) => {
        const list = groupTies.filter((t) => t.group_id === g.id);
        if (list.length === 0) return null;
        return (
          <section key={g.id} className="space-y-2">
            <h3 className="font-bold">{g.group_name}</h3>
            <div className="grid gap-3 lg:grid-cols-2">{list.map(tieCard)}</div>
          </section>
        );
      })}

      {groupTies.length > 0 && (
        <section className="space-y-3">
          <h3 className="font-bold">Placement draws</h3>
          <PlacementControls tournamentId={id} drawn={placementTies.length > 0} ready={groupsDone} />
          {[...new Set(placementTies.map((t) => `${t.draw_from}-${t.draw_to}`))].map((draw) => {
            const inDraw = placementTies.filter((t) => `${t.draw_from}-${t.draw_to}` === draw);
            const rounds = [...new Set(inDraw.map((t) => t.round_no))].sort();
            return (
              <div key={draw} className="space-y-2">
                <h4 className="text-sm font-bold text-muted">Places {draw.replace("-", "–")}</h4>
                {rounds.map((r) => (
                  <div key={r} className="grid gap-3 lg:grid-cols-2">{inDraw.filter((t) => t.round_no === r).map(tieCard)}</div>
                ))}
              </div>
            );
          })}
        </section>
      )}

      {placings.length > 0 && (
        <section className="card space-y-2" data-testid="final-placings">
          <h3 className="font-bold">Final places</h3>
          <ol className="grid gap-1 sm:grid-cols-2">
            {placings.map((p) => {
              const t = teamBy.get(p.team_id);
              return (
                <li key={p.place} className="flex gap-3 text-sm">
                  <span className="w-10 font-mono font-bold">{ordinal(p.place)}</span>
                  <span>{t?.team_name}</span>
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </div>
  );
}

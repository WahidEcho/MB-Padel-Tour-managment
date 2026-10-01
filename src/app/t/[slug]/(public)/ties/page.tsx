import Link from "next/link";
import { notFound } from "next/navigation";
import { getCourts, getMatches, getSnapshots, getTeams, getTournamentBySlug, teamMap } from "@/lib/data";
import { getTies } from "@/lib/tennis/tieOps";
import { RUBBER_SHORT } from "@/lib/tennis/ties";
import AutoRefresh from "@/components/AutoRefresh";
import MatchStatusBadge from "@/components/MatchStatusBadge";
import type { Match, MatchSnapshot, RubberType, Team, Tie } from "@/lib/types";

// Rendered at most every 4s and shared by every visitor: at the venue a crowd
// refreshing this page reads one cached copy instead of the database each time.
export const revalidate = 4;

/**
 * Every tie of a nations event with its rubbers, in order of play: what a fan
 * without the app follows. Live ties first, then the day's order, then results.
 */
export default async function PublicTies({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tournament = await getTournamentBySlug(slug);
  if (!tournament || !tournament.format_config?.ties) notFound();
  const id = tournament.id;
  const [ties, matches, teams, snapshots, courts] = await Promise.all([getTies(id), getMatches(id), getTeams(id), getSnapshots(id), getCourts(id)]);
  const tm = teamMap(teams);
  const snap = new Map(snapshots.map((s) => [s.match_id, s]));
  const court = new Map(courts.map((c) => [c.id, c.court_name]));
  const rubbersOf = (tieId: string) => matches.filter((m) => m.tie_id === tieId).sort((a, b) => (a.rubber_no ?? 0) - (b.rubber_no ?? 0));
  const tz = tournament.timezone || "Africa/Cairo";
  const when = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "Time to be set";
  const live = ties.filter((t) => t.status === "live");
  const upcoming = ties.filter((t) => t.status === "scheduled").sort((a, b) => (a.scheduled_time ?? "9").localeCompare(b.scheduled_time ?? "9"));
  const done = ties.filter((t) => t.status === "completed").sort((a, b) => (b.ended_at ?? "").localeCompare(a.ended_at ?? ""));

  const section = (title: string, list: Tie[]) =>
    list.length > 0 && (
      <section className="space-y-2">
        <h2 className="label">{title}</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {list.map((t) => (
            <TieCard key={t.id} tie={t} a={t.team_a_id ? tm.get(t.team_a_id) : undefined} b={t.team_b_id ? tm.get(t.team_b_id) : undefined} rubbers={rubbersOf(t.id)} snap={snap} teams={tm} court={t.court_id ? court.get(t.court_id) : undefined} when={when(t.scheduled_time)} slug={slug} />
          ))}
        </div>
      </section>
    );

  return (
    <div className="space-y-6">
      <AutoRefresh seconds={8} />
      <h1 className="text-2xl font-bold">Ties</h1>
      {section("Live", live)}
      {section("Coming up", upcoming)}
      {section("Results", done)}
      {ties.length === 0 && <p className="card p-6 text-center text-muted">The order of play is not out yet.</p>}
    </div>
  );
}

function Nation({ team, right }: { team: Team | undefined; right?: boolean }) {
  const flag = team?.iso2 && /^[a-z]{2}$/.test(team.iso2) ? `/flags/${team.iso2}.svg` : null;
  return (
    <span className={`flex min-w-0 items-center gap-2 font-bold ${right ? "flex-row-reverse text-right" : ""}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {flag && <img src={flag} alt="" className="h-5 w-7 rounded-sm object-cover shadow" />}
      <span className="truncate">{team?.team_name ?? "TBD"}</span>
    </span>
  );
}

function setLine(s: MatchSnapshot | undefined): string {
  if (!s) return "";
  const sets = (s.completed_sets ?? []).map((x) => `${x.teamAGames}–${x.teamBGames}`);
  const over = (s.snapshot_json as { matchOver?: boolean } | null)?.matchOver;
  if (!over && (s.team_a_games || s.team_b_games || s.team_a_point_label !== "0" || s.team_b_point_label !== "0")) sets.push(`${s.team_a_games}–${s.team_b_games}`);
  return sets.join(" ");
}

function TieCard(props: {
  tie: Tie;
  a: Team | undefined;
  b: Team | undefined;
  rubbers: Match[];
  snap: Map<string, MatchSnapshot>;
  teams: Map<string, Team>;
  court: string | undefined;
  when: string;
  slug: string;
}) {
  const { tie, a, b, rubbers, snap, teams } = props;
  const names = (teamId: string | null, ids: string[] | null | undefined) => {
    const t = teamId ? teams.get(teamId) : undefined;
    const ps = ids?.length ? (t?.players ?? []).filter((p) => ids.includes(p.id)) : [];
    return ps.length ? ps.map((p) => p.full_name).join(" / ") : "To be nominated";
  };
  return (
    <article className="card space-y-2">
      <p className="text-xs text-muted">
        {tie.round_name ?? (tie.stage === "group" ? "Group stage" : "Placement")} · {props.court ?? "Court to be set"} · {props.when}
      </p>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <Nation team={a} />
        <span className="text-2xl font-black tabular-nums">{tie.rubbers_a}–{tie.rubbers_b}</span>
        <Nation team={b} right />
      </div>
      <ul className="divide-y divide-border text-sm">
        {rubbers.map((r) => (
          <li key={r.id}>
            <Link href={`/t/${props.slug}/match/${r.id}`} className="grid grid-cols-[2.5rem_1fr_auto] items-center gap-2 py-2 hover:text-accent">
              <span className="font-bold text-muted">{RUBBER_SHORT[r.rubber_type as RubberType] ?? r.rubber_type}</span>
              <span className="min-w-0">
                <span className={`block truncate ${r.winner_team_id && r.winner_team_id === r.team_a_id ? "font-bold" : ""}`}>{names(r.team_a_id, r.team_a_player_ids)}</span>
                <span className={`block truncate ${r.winner_team_id && r.winner_team_id === r.team_b_id ? "font-bold" : ""}`}>{names(r.team_b_id, r.team_b_player_ids)}</span>
              </span>
              <span className="flex flex-col items-end gap-1">
                <MatchStatusBadge status={r.status} />
                <span className="tabular-nums text-xs text-muted">{setLine(snap.get(r.id))}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </article>
  );
}

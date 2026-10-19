import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/supabase";
import { requireStaff } from "@/lib/guard";
import { getTeams, teamMap } from "@/lib/data";
import { physicalCourts, type CourtScope } from "@/lib/orgs/courtScope";
import { courtDay } from "@/lib/referee/courtList";
import MatchStatusBadge from "@/components/MatchStatusBadge";
import MasterCalls from "@/components/referee/MasterCalls";
import AutoRefresh from "@/components/AutoRefresh";
import type { Match, Team } from "@/lib/types";

export const dynamic = "force-dynamic";

const clock = (iso: string | null, timeZone: string) =>
  iso ? new Date(iso).toLocaleTimeString("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" }) : null;

/**
 * The master referee's page (migration 0035): the calls for assistance of every court
 * (On my way / Resolved), a court picker across the events it covers (one entry per
 * physical court, both events), the picked court's matches today with a link to score
 * any of them, and each event's match desk (add matches, generate from the draw).
 * The organiser's staff may open it too.
 */
export default async function MasterRefereePage({ searchParams }: { searchParams: Promise<{ court?: string }> }) {
  const staff = await requireStaff(["referee", "admin", "manager"], "/referee/master");
  const master = staff.referee?.role === "master_referee";
  const organiser = staff.kind !== "code" && (staff.role === "admin" || staff.role === "manager");
  if (!master && !organiser) notFound();
  const { court: picked } = await searchParams;

  let tq = db().from("tournaments").select("id, name, timezone, status").eq("organization_id", staff.orgId).eq("kind", "tournament").in("status", ["draft", "active"]);
  if (staff.scopeTournamentIds) tq = tq.in("id", staff.scopeTournamentIds.length ? staff.scopeTournamentIds : ["00000000-0000-4000-8000-000000000000"]);
  const { data: tRows } = await tq.order("created_at", { ascending: true }).limit(40);
  const tournaments = (tRows ?? []) as { id: string; name: string; timezone: string | null; status: string }[];
  const ids = tournaments.map((t) => t.id);
  const { data: cRows } = ids.length
    ? await db().from("courts").select("id, tournament_id, court_name, court_order, is_active").in("tournament_id", ids).limit(500)
    : { data: [] };
  const courts = physicalCourts(((cRows ?? []) as { id: string; tournament_id: string; court_name: string; court_order: number | null; is_active: boolean | null }[]).filter((c) => c.is_active !== false));
  const current = courts.find((c) => c.key === picked) ?? null;
  const scope: CourtScope | null = current ? { name: current.name, key: current.key, eventGroupId: null, tournamentIds: current.tournamentIds, courtIds: current.courtIds, withCourt: current.tournamentIds } : null;
  const day = scope ? await courtDay(scope) : null;
  const teams = new Map<string, Team>();
  if (day) for (const list of await Promise.all([...day.tournaments.keys()].map((id) => getTeams(id)))) for (const [k, v] of teamMap(list)) teams.set(k, v);
  const side = (m: Match, which: "a" | "b") => {
    const id = which === "a" ? m.team_a_id : m.team_b_id;
    const t = id ? teams.get(id) : undefined;
    if (!t) return id ? "?" : "TBD";
    const pids = (which === "a" ? m.team_a_player_ids : m.team_b_player_ids) ?? [];
    const names = m.tie_id && pids.length ? (t.players ?? []).filter((p) => pids.includes(p.id)).map((p) => p.full_name.split(" ").slice(-1)[0]) : [];
    return names.length ? `${names.join(" / ")} (${t.nation_code ?? t.team_name})` : t.team_name;
  };
  const row = (m: Match) => {
    const t = day!.tournaments.get(m.tournament_id);
    const tz = t?.timezone || "Africa/Cairo";
    return (
      <Link key={m.id} href={`/referee/matches/${m.id}/score`} className="card flex items-center justify-between gap-2 hover:border-accent" data-testid="master-court-match" data-match-id={m.id}>
        <div className="min-w-0">
          <p className="text-xs text-muted">
            {clock(m.scheduled_time, tz) ?? "No time"} · {t?.name ?? ""} · {m.round_name}
            {m.rubber_type ? ` · ${m.rubber_type}` : ""}
          </p>
          <p className="truncate text-base font-bold">
            {side(m, "a")} <span className="text-muted">vs</span> {side(m, "b")}
          </p>
          {day!.scores.get(m.id) && <p className="text-sm font-semibold tabular-nums">{day!.scores.get(m.id)}</p>}
        </div>
        <MatchStatusBadge status={m.status} />
      </Link>
    );
  };

  return (
    <div className="space-y-6" data-testid="master-page">
      <AutoRefresh seconds={15} />
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-accent">{master ? "Master referee" : "Organiser"}</p>
        <h1 className="text-2xl font-bold">{master ? staff.referee!.name : staff.orgName}</h1>
        <p className="text-xs text-muted">Every court of {tournaments.map((t) => t.name).join(" and ") || "your events"}.</p>
      </div>

      <MasterCalls />

      <section className="space-y-2">
        <h2 className="text-lg font-bold">Courts</h2>
        <div className="flex flex-wrap gap-2" data-testid="court-picker">
          {courts.map((c) => (
            <Link
              key={c.key}
              href={`/referee/master?court=${encodeURIComponent(c.key)}`}
              className={`rounded-xl border px-4 py-2 text-sm font-bold ${c.key === current?.key ? "border-accent bg-accent/15 text-accent" : "border-border bg-card hover:border-accent"}`}
              data-testid="court-pick"
            >
              {c.name}
            </Link>
          ))}
          {courts.length === 0 && <p className="text-sm text-muted">No courts set up yet.</p>}
        </div>
        {day && current && (
          <div className="space-y-2" data-testid="master-court">
            <h3 className="font-bold">{current.name}: today</h3>
            {[...day.live, ...day.upcoming, ...day.finished].map(row)}
            {day.live.length + day.upcoming.length + day.finished.length === 0 && <p className="card p-4 text-center text-sm text-muted">Nothing on {current.name} today.</p>}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-bold">Events</h2>
        {tournaments.map((t) => (
          <div key={t.id} className="card flex flex-wrap items-center justify-between gap-2">
            <span className="text-base font-bold">{t.name}</span>
            <span className="flex gap-2 text-sm">
              <Link href={`/referee/tournaments/${t.id}/matches`} className="btn-secondary text-xs">All matches</Link>
              <Link href={`/referee/tournaments/${t.id}/desk`} className="btn-primary text-xs" data-testid="desk-link">Match desk</Link>
            </span>
          </div>
        ))}
      </section>
    </div>
  );
}

import Link from "next/link";
import { getTeams, teamMap } from "@/lib/data";
import { courtDay } from "@/lib/referee/courtList";
import type { CourtScope } from "@/lib/orgs/courtScope";
import type { Match, Team } from "@/lib/types";
import MatchStatusBadge from "@/components/MatchStatusBadge";
import AutoRefresh from "@/components/AutoRefresh";
import PendingPoints from "./PendingPoints";
import AssistanceButton from "@/components/referee/AssistanceButton";
import { currentCarries } from "@/lib/auth/staff";
import { principalReaches, resolveEntity } from "@/lib/orgs/scope";

/** The old court's matches this browser still holds after switching courts (its carry-over cookie). */
async function carriedMatches(): Promise<string[]> {
  const out: string[] = [];
  for (const c of await currentCarries()) {
    for (const id of c.scopeMatchIds ?? []) if (principalReaches(c, await resolveEntity({ match: id }))) out.push(id);
  }
  return [...new Set(out)];
}

const clock = (iso: string | null, timeZone: string) =>
  iso ? new Date(iso).toLocaleTimeString("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" }) : null;

/**
 * A court referee's home (migration 0034): today's matches on this court, every
 * event of the venue in one list. Moved matches appear and disappear on the next
 * refresh; the scoring routes check the court again on every request anyway.
 */
export default async function CourtList({ scope, label, assistance = false }: { scope: CourtScope; label: string | null; assistance?: boolean }) {
  const [day, carried] = await Promise.all([courtDay(scope), carriedMatches()]);
  const teams = new Map<string, Team>();
  const tids = [...day.tournaments.keys()];
  for (const list of await Promise.all(tids.map((id) => getTeams(id)))) for (const [k, v] of teamMap(list)) teams.set(k, v);
  const several = tids.length > 1;

  const side = (m: Match, which: "a" | "b") => {
    const id = which === "a" ? m.team_a_id : m.team_b_id;
    if (!id) return "TBD";
    const t = teams.get(id);
    if (!t) return "?";
    const nominees = which === "a" ? m.team_a_player_ids : m.team_b_player_ids;
    if (m.tie_id && nominees?.length) {
      const names = (t.players ?? []).filter((p) => nominees.includes(p.id)).map((p) => p.full_name);
      if (names.length) return `${names.join(" / ")} (${t.nation_code ?? t.team_name})`;
    }
    return t.team_name;
  };

  const row = (m: Match, dim = false) => {
    const t = day.tournaments.get(m.tournament_id);
    const tz = t?.timezone ?? "Africa/Cairo";
    const bits = [clock(m.scheduled_time, tz) ?? "no time set", m.rubber_type, m.round_name, several ? t?.name : null].filter(Boolean);
    return (
      <Link
        key={m.id}
        href={`/referee/matches/${m.id}/score`}
        data-testid="court-match"
        data-match-id={m.id}
        className={`card flex items-center justify-between gap-2 hover:border-accent ${dim ? "opacity-70 hover:opacity-100" : ""}`}
      >
        <div className="min-w-0">
          <p className="text-xs text-muted">{bits.join(" · ")}</p>
          <p className="text-lg font-bold">
            {side(m, "a")} <span className="text-muted">vs</span> {side(m, "b")}
          </p>
          {day.scores.get(m.id) && <p className="text-sm font-semibold tabular-nums" data-testid="court-match-score">{day.scores.get(m.id)}</p>}
        </div>
        <MatchStatusBadge status={m.status} />
      </Link>
    );
  };

  return (
    <div className="space-y-5" data-testid="court-list">
      <AutoRefresh seconds={10} />
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-accent">Court referee</p>
        <h1 className="text-2xl font-bold" data-testid="court-name">{scope.name}</h1>
        <p className="text-xs text-muted">
          {label ? `${label} · ` : ""}Today&apos;s matches on this court only.{" "}
          <a href="/login?switch=1&next=/referee" className="underline" data-testid="switch-court">Switch court</a> (type the other court&apos;s code; a match you have not finished or sent stays yours).
        </p>
      </div>
      {assistance && <AssistanceButton />}
      <PendingPoints />
      {carried.length > 0 && (
        <section className="space-y-2" data-testid="carried">
          <h2 className="label">Still yours from your last court</h2>
          <p className="text-xs text-muted">Finish these and send their points; the old court&apos;s access ends for each once it is finished.</p>
          {carried.map((id) => (
            <a key={id} href={`/referee/matches/${id}/score`} className="btn-secondary text-xs" data-match-id={id}>Open that match</a>
          ))}
        </section>
      )}

      <section className="space-y-2">
        <h2 className="label">Live</h2>
        {day.live.map((m) => row(m))}
        {day.live.length === 0 && <p className="card p-4 text-center text-sm text-muted">Nothing live on this court.</p>}
      </section>

      <section className="space-y-2">
        <h2 className="label">Up next</h2>
        {day.upcoming.map((m) => row(m))}
        {day.upcoming.length === 0 && <p className="card p-4 text-center text-sm text-muted">No more matches on this court today.</p>}
      </section>

      {day.finished.length > 0 && (
        <section className="space-y-2">
          <h2 className="label">Finished today</h2>
          {day.finished.map((m) => row(m, true))}
        </section>
      )}

      {day.earlier.length > 0 && (
        <details className="space-y-2" data-testid="earlier-days">
          <summary className="btn-secondary cursor-pointer list-none text-xs">Show earlier days</summary>
          {day.earlier.map((d) => (
            <section key={d.day} className="mt-3 space-y-2">
              <h2 className="label">{new Date(`${d.day}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })}</h2>
              {d.matches.map((m) => row(m, true))}
            </section>
          ))}
        </details>
      )}
    </div>
  );
}

/* eslint-disable @next/next/no-img-element -- local flag SVGs */
import Link from "next/link";
import { isDoneStatus, isLiveStatus, scoreLine, type MCoachRubber, type MCoachSlot, type MCoachTeamRef, type MCoachTeamView, type MCoachTie } from "@/lib/mobile/contract";

/**
 * The coach's web views (migration 0037): their own team only, read-only. The same model
 * the app draws (GET /api/mobile/v1/coach/team): scores are oriented, our team first.
 */

export function when(iso: string | null, tz: string, withDay = true): string {
  if (!iso) return "Time to be set";
  return new Date(iso).toLocaleString("en-GB", { timeZone: tz, ...(withDay ? { weekday: "short", day: "numeric", month: "short" } : {}), hour: "2-digit", minute: "2-digit" });
}

export function TeamName({ team, strong = true }: { team: MCoachTeamRef | null; strong?: boolean }) {
  if (!team) return <span className="text-muted">To be decided</span>;
  const flag = team.iso2 && /^[a-z]{2}(-[a-z]+)?$/.test(team.iso2) ? `/flags/${team.iso2}.svg` : null;
  return (
    <span className={`inline-flex min-w-0 items-center gap-2 ${strong ? "font-bold" : ""}`}>
      {flag && <img src={flag} alt="" className="h-4 w-6 shrink-0 rounded-sm object-cover shadow" />}
      <span className="truncate">{team.name}</span>
    </span>
  );
}

function StatusChip({ status, result }: { status: string; result: "us" | "them" | null }) {
  if (isLiveStatus(status as never)) return <span className="rounded-full bg-danger/15 px-2 py-0.5 text-[11px] font-bold uppercase text-danger">Live</span>;
  if (isDoneStatus(status as never) || status === "completed") {
    if (result === "us") return <span className="rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-bold uppercase text-success">Won</span>;
    if (result === "them") return <span className="rounded-full bg-border px-2 py-0.5 text-[11px] font-bold uppercase text-muted">Lost</span>;
    return <span className="rounded-full bg-border px-2 py-0.5 text-[11px] font-bold uppercase text-muted">Final</span>;
  }
  if (status === "ready") return <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-bold uppercase text-accent">Called</span>;
  if (status === "cancelled") return <span className="rounded-full bg-border px-2 py-0.5 text-[11px] font-bold uppercase text-muted">Not played</span>;
  return <span className="rounded-full bg-border px-2 py-0.5 text-[11px] font-bold uppercase text-muted">Scheduled</span>;
}

export function RubberLine({ r, tz, us, them, link = true }: { r: MCoachRubber; tz: string; us: MCoachTeamRef; them: MCoachTeamRef | null; link?: boolean }) {
  const line = scoreLine(r.score);
  const points = r.score?.points && isLiveStatus(r.status) ? `${r.score.points.a}–${r.score.points.b}` : null;
  const body = (
    <div className="flex flex-col gap-1 rounded-xl border border-border p-3" data-testid="coach-rubber">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="font-semibold">{r.label}</span>
        <StatusChip status={r.status} result={r.result} />
      </div>
      <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-sm">
        <span className="truncate" data-testid="coach-ours">
          <strong>{us.code}</strong> {r.ours.length ? r.ours.map((p) => p.name).join(" / ") : <span className="text-muted">line-up not entered yet</span>}
        </span>
        <span className="text-right font-mono font-bold">{line}</span>
        <span className="truncate text-muted" data-testid="coach-theirs">
          <strong>{them?.code ?? "TBD"}</strong> {r.theirs ? (r.theirs.length ? r.theirs.map((p) => p.name).join(" / ") : "to be named") : "shown once the line-ups are confirmed"}
        </span>
        <span className="text-right font-mono text-muted">{points ?? ""}</span>
      </div>
      <p className="text-xs text-muted">{[r.court, r.scheduledTime ? when(r.scheduledTime, tz) : null].filter(Boolean).join(" · ") || "Court and time to be set"}</p>
    </div>
  );
  return link ? (
    <Link href={`/coach/matches/${r.matchId}`} className="block hover:opacity-90">
      {body}
    </Link>
  ) : (
    body
  );
}

export function TieBlock({ tie, tz, team, open = false }: { tie: MCoachTie; tz: string; team: MCoachTeamRef; open?: boolean }) {
  return (
    <article className="card space-y-3" data-testid="coach-tie" data-tie={tie.id}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">{tie.stageLabel}</p>
          <Link href={`/coach/ties/${tie.id}`} className="flex flex-wrap items-center gap-2 text-lg hover:underline">
            <TeamName team={team} /> <span className="text-muted">v</span> <TeamName team={tie.opponent} />
          </Link>
          <p className="text-sm text-muted">{tie.court ?? "Court to be set"} · {when(tie.scheduledTime, tz)}</p>
        </div>
        <div className="text-right">
          <p className="font-mono text-2xl font-black">{tie.rubbersUs}–{tie.rubbersThem}</p>
          <StatusChip status={tie.status} result={tie.result} />
        </div>
      </div>
      {tie.lineupEntry ? (
        tie.lineupEntry.open && !open ? (
          <Link href={`/coach/ties/${tie.id}`} className="btn-primary inline-block text-sm" data-testid="coach-enter-lineup">
            {tie.lineupEntry.submittedAt ? "Change the line-up" : "Enter line-up"}
          </Link>
        ) : null
      ) : (
        !tie.lineupEntered && tie.status === "scheduled" && <p className="text-xs text-muted">Your line-up is not entered yet. Give it to the referee as usual; it shows here once entered.</p>
      )}
      {open && (
        <div className="grid gap-2 md:grid-cols-3">
          {tie.rubbers.map((r) => (
            <RubberLine key={r.matchId} r={r} tz={tz} us={team} them={tie.opponent} />
          ))}
        </div>
      )}
    </article>
  );
}

export function GroupTable({ group, teamId }: { group: NonNullable<MCoachTeamView["group"]>; teamId: string }) {
  return (
    <div className="overflow-x-auto rounded-[20px] border border-border">
      <table className="w-full text-sm" data-testid="coach-group">
        <thead className="bg-card text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="px-3 py-2">#</th>
            <th className="px-3 py-2">Team</th>
            <th className="px-3 py-2 text-right">P</th>
            <th className="px-3 py-2 text-right">W</th>
            <th className="px-3 py-2 text-right">Rubbers</th>
            <th className="px-3 py-2 text-right">Sets</th>
            <th className="px-3 py-2 text-right">Games</th>
          </tr>
        </thead>
        <tbody>
          {group.rows.map((r) => (
            <tr key={r.teamId} className={`border-t border-border ${r.teamId === teamId ? "bg-accent/10 font-semibold" : ""}`}>
              <td className="px-3 py-2">{r.rank}</td>
              <td className="px-3 py-2"><TeamName team={r.team} strong={r.teamId === teamId} /></td>
              <td className="px-3 py-2 text-right">{r.played}</td>
              <td className="px-3 py-2 text-right">{r.won}</td>
              <td className="px-3 py-2 text-right">{r.rubbersWon ?? 0}–{r.rubbersLost ?? 0}</td>
              <td className="px-3 py-2 text-right">{r.setsWon}–{r.setsLost}</td>
              <td className="px-3 py-2 text-right">{r.gamesWon}–{r.gamesLost}</td>
            </tr>
          ))}
          {group.rows.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-4 text-center text-muted">No results yet.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function PlayerSchedule({ players, schedule, tz }: { players: { id: string; name: string }[]; schedule: MCoachSlot[]; tz: string }) {
  return (
    <div className="grid gap-2 md:grid-cols-2">
      {players.map((p) => {
        const mine = schedule.filter((s) => s.playerId === p.id);
        return (
          <div key={p.id} className="card space-y-1" data-testid="coach-player">
            <p className="font-semibold">{p.name}</p>
            {mine.length === 0 && <p className="text-xs text-muted">Not in a line-up yet.</p>}
            {mine.map((s) => (
              <Link key={s.matchId} href={`/coach/matches/${s.matchId}`} className="flex justify-between gap-2 text-sm hover:underline">
                <span>{s.label} v {s.opponent ?? "TBD"}</span>
                <span className="text-muted">{[s.court, s.scheduledTime ? when(s.scheduledTime, tz) : null].filter(Boolean).join(" · ")}</span>
              </Link>
            ))}
          </div>
        );
      })}
    </div>
  );
}

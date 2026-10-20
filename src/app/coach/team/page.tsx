import Link from "next/link";
import { redirect } from "next/navigation";
import AutoRefresh from "@/components/AutoRefresh";
import { GroupTable, PlayerSchedule, TeamName, TieBlock } from "@/components/coach/CoachViews";
import { coachTeamView, currentCoachResolution } from "@/lib/coaches/server";

export const dynamic = "force-dynamic";

/** "My team" on the web: the same view as the app's (GET /api/mobile/v1/coach/team). */
export default async function MyTeam() {
  const me = await currentCoachResolution();
  if (!me.ok) redirect(`/coach?error=${me.reason}`);
  const v = await coachTeamView(me.coach);
  if (!v) redirect("/coach?error=signed_out");
  const tz = v.event.timeZone;
  const next = v.ties.find((t) => t.id === v.nextTieId) ?? null;
  const live = v.ties.filter((t) => t.status === "live");
  const others = v.ties.filter((t) => t.id !== next?.id && t.status !== "live");
  return (
    <div className="space-y-6" data-testid="coach-team">
      <AutoRefresh seconds={10} />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">{v.event.group ? `${v.event.group} · ` : ""}{v.event.name}</p>
          <h1 className="text-3xl font-black"><TeamName team={v.team} /></h1>
          <p className="text-sm text-muted" data-testid="coach-landing">
            {v.place ? `Final place: ${v.place}` : v.landing ? `After the groups: ${v.landing}` : v.group ? `Group ${v.group.name}` : ""}
          </p>
        </div>
        <form action="/coach/signout" method="post">
          <button className="btn-secondary text-sm">Sign out</button>
        </form>
      </div>

      {live.length > 0 && (
        <section className="space-y-2">
          <h2 className="label">Live now</h2>
          {live.map((t) => <TieBlock key={t.id} tie={t} tz={tz} team={v.team} open />)}
        </section>
      )}
      {next && next.status !== "live" && (
        <section className="space-y-2">
          <h2 className="label">Next tie</h2>
          <TieBlock tie={next} tz={tz} team={v.team} open />
        </section>
      )}

      {v.group && (
        <section className="space-y-2">
          <h2 className="label">Group {v.group.name}</h2>
          <GroupTable group={v.group} teamId={v.team.id} />
        </section>
      )}

      <section className="space-y-2">
        <h2 className="label">All ties</h2>
        {others.map((t) => <TieBlock key={t.id} tie={t} tz={tz} team={v.team} />)}
        {v.ties.length === 0 && <p className="card p-6 text-center text-muted">Your ties are not drawn yet.</p>}
      </section>

      <section className="space-y-2">
        <h2 className="label">Players&apos; schedule</h2>
        <PlayerSchedule players={v.team.players} schedule={v.schedule} tz={tz} />
      </section>
      <p className="text-xs text-muted">Read only. Line-ups are entered by the referee; for anything on court, speak to the referee. <Link href="/coach/team" className="underline">Refresh</Link></p>
    </div>
  );
}

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import AutoRefresh from "@/components/AutoRefresh";
import { RubberLine } from "@/components/coach/CoachViews";
import { coachMatch, coachTimeZone, currentCoachResolution } from "@/lib/coaches/server";

export const dynamic = "force-dynamic";

/** One of the coach's own rubbers: live score and match log (no referee names). Any other match: 404. */
export default async function CoachMatchPage({ params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  const me = await currentCoachResolution();
  if (!me.ok) redirect(`/coach?error=${me.reason}`);
  const m = await coachMatch(me.coach, matchId);
  if (!m) notFound();
  const tz = await coachTimeZone(me.coach.tournamentId);
  const at = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
  return (
    <div className="space-y-4">
      <AutoRefresh seconds={5} />
      <p className="text-xs">
        <Link href="/coach/team" className="text-muted hover:text-foreground">← My team</Link>
        {m.tieId && <> · <Link href={`/coach/ties/${m.tieId}`} className="text-muted hover:text-foreground">The tie</Link></>}
      </p>
      <RubberLine r={m.rubber} tz={tz} us={m.team} them={m.opponent} link={false} />
      <section className="space-y-2">
        <h2 className="label">Match log</h2>
        <ol className="space-y-1" data-testid="coach-log">
          {[...m.log].reverse().map((e) => (
            <li key={e.n} className={`card flex items-start justify-between gap-3 py-2 text-sm ${e.undone ? "opacity-50 line-through" : ""}`}>
              <div className="min-w-0">
                <p className="font-semibold">{e.title}</p>
                <p className="text-muted">{e.detail}</p>
              </div>
              <div className="shrink-0 text-right text-xs text-muted">
                {e.chip && <p className="font-bold uppercase">{e.chip}</p>}
                <p>{at(e.at)}</p>
              </div>
            </li>
          ))}
          {m.log.length === 0 && <li className="card p-4 text-center text-sm text-muted">Nothing yet: the log starts with the first point.</li>}
        </ol>
      </section>
    </div>
  );
}

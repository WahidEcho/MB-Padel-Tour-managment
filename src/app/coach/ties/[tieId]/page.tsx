import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import AutoRefresh from "@/components/AutoRefresh";
import { TieBlock } from "@/components/coach/CoachViews";
import CoachLineupForm from "@/components/coach/CoachLineupForm";
import { coachTie, coachTimeZone, currentCoachResolution } from "@/lib/coaches/server";
import { coachLineupEntry } from "@/lib/coaches/lineups";

export const dynamic = "force-dynamic";

/**
 * One of the coach's own ties with its rubbers; any other tie is a 404 like a missing one.
 * While the event's coach line-up entry is switched on (off by default), the coach's own
 * line-up form too (never the opponents').
 */
export default async function CoachTiePage({ params }: { params: Promise<{ tieId: string }> }) {
  const { tieId } = await params;
  const me = await currentCoachResolution();
  if (!me.ok) redirect(`/coach?error=${me.reason}`);
  const tie = await coachTie(me.coach, tieId);
  if (!tie) notFound();
  const [tz, entry] = await Promise.all([coachTimeZone(me.coach.tournamentId), coachLineupEntry(me.coach, tieId)]);
  return (
    <div className="space-y-4">
      {!entry?.open && <AutoRefresh seconds={8} />}
      <p className="text-xs"><Link href="/coach/team" className="text-muted hover:text-foreground">← My team</Link></p>
      <TieBlock tie={tie} tz={tz} team={me.coach.team} open />
      {entry && <CoachLineupForm tieId={tie.id} initial={entry} timeZone={tz} />}
      <p className="text-xs text-muted">{tie.lineupLocked ? "Line-ups are confirmed: the opponents' players are shown." : "Line-ups are not confirmed yet. The opponents' players show once the referee confirms the line-ups (or a rubber starts)."}</p>
    </div>
  );
}

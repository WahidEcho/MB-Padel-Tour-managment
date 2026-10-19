import Link from "next/link";
import { notFound } from "next/navigation";
import { requireEntityPage } from "@/lib/guard";
import LineupPicker from "@/components/lineups/LineupPicker";
import { lineupActor, lineupPicker } from "@/lib/tennis/lineupServer";

export const dynamic = "force-dynamic";

/**
 * A tie's line-ups from one of its rubbers: the court referee of the tie's court, a
 * master referee or the organiser (lineupActor). Another court's tie and another
 * organisation's are a 404 (the match decides the organisation and the court).
 */
export default async function LineupPage({ params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  const { staff } = await requireEntityPage({ match: matchId }, ["referee", "admin", "manager"], `/referee/matches/${matchId}/lineup`);
  const actor = lineupActor(staff);
  if (!actor) notFound();
  const picker = await lineupPicker(matchId, actor);
  if (!picker) notFound();
  return (
    <div className="mx-auto max-w-2xl space-y-3">
      <Link href={`/referee/matches/${matchId}/score`} className="text-sm text-muted hover:text-foreground">← Back to the match</Link>
      <LineupPicker initial={picker} />
    </div>
  );
}

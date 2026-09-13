import Link from "next/link";
import { getSessionByTournament } from "@/lib/friendly/data";

/**
 * Shown in place of a tournament tool when the row is a friendly session's hidden
 * tournament. The tool's forms are not rendered at all — their actions refuse the
 * row too, but an organiser should never be offered a button that can only fail.
 */
export default async function SessionRowNotice({
  tournamentId,
  tool,
  title,
}: {
  tournamentId: string;
  /** What the page manages, plural: "Matches", "Knockout brackets". */
  tool: string;
  /** A whole heading, when "… are managed from the friendly session" does not fit. */
  title?: string;
}) {
  const session = await getSessionByTournament(tournamentId);
  return (
    <div className="card space-y-2 border-warning/50" data-testid="session-row-notice">
      <p className="font-semibold">{title ?? `${tool} are managed from the friendly session.`}</p>
      <p className="text-sm text-muted">
        This is the hidden tournament behind {session ? <b>{session.name}</b> : "a friendly session"}. Its players,
        pairs, schedule, results and points belong to the session, so the tournament tools are not available here —
        they would delete players&apos; points without recalculating the rankings. Its TV screens, courts and
        branding, and stuck scoring locks, are managed from the tabs above.
      </p>
      <div className="flex flex-wrap gap-2">
        {session && (
          <Link href={`/admin/friendly-sessions/${session.id}`} className="btn-primary text-xs">
            Open the session
          </Link>
        )}
        <Link href={`/admin/tournaments/${tournamentId}/screens`} className="btn-secondary text-xs">
          Screens
        </Link>
      </div>
    </div>
  );
}

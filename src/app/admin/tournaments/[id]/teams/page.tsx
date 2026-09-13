import Link from "next/link";
import { getTeams, getTournament } from "@/lib/data";
import TeamsClient from "./TeamsClient";
import SessionRowNotice from "../SessionRowNotice";

export const dynamic = "force-dynamic";

export default async function TeamsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [teams, tournament] = await Promise.all([getTeams(id), getTournament(id)]);
  if (tournament && tournament.kind !== "tournament") return <SessionRowNotice tournamentId={id} tool="Players and pairs" />;
  const isChess = tournament?.sport === "chess";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold">
          {isChess ? "Players" : "Teams"} ({teams.length})
        </h2>
        {!isChess && (
          <div className="flex gap-2">
            <a href="/api/csv-template" className="btn-secondary text-xs">Download CSV template</a>
            <Link href={`/admin/tournaments/${id}/teams/import`} className="btn-secondary text-xs">
              Import CSV
            </Link>
          </div>
        )}
      </div>

      <TeamsClient tournamentId={id} teams={teams} isChess={isChess} />
    </div>
  );
}

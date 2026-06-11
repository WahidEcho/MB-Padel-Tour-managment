import { getTeams } from "@/lib/data";
import ImportClient from "./ImportClient";

export const dynamic = "force-dynamic";

export default async function ImportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const teams = await getTeams(id);
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h2 className="text-lg font-bold">Import teams from CSV</h2>
      <p className="text-sm text-muted">
        1. <a href="/api/csv-template" className="font-semibold text-accent">Download the CSV template</a>.
        2. Fill it in. 3. Upload it here, preview the rows, and confirm the import.
      </p>
      <ImportClient tournamentId={id} existingTeamNames={teams.map((t) => t.team_name)} />
    </div>
  );
}

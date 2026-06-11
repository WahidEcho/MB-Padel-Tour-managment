import { notFound } from "next/navigation";
import { getTournament } from "@/lib/data";
import { cloneTournamentAction } from "../../actions";

export const dynamic = "force-dynamic";

const COPY_OPTIONS = [
  ["copy_teams", "Teams and players"],
  ["copy_photos", "Player photos"],
  ["copy_groups", "Groups and team placement"],
  ["copy_schedule", "Match schedule"],
  ["copy_branding", "Branding"],
  ["copy_scoring", "Scoring rules"],
  ["copy_courts", "Courts"],
] as const;

export default async function ClonePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tournament = await getTournament(id);
  if (!tournament) notFound();

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h2 className="text-lg font-bold">Clone Tournament</h2>
      <form action={cloneTournamentAction} className="card space-y-4 p-6">
        <input type="hidden" name="source_id" value={id} />
        <div>
          <label className="label">New tournament name</label>
          <input name="name" defaultValue={`${tournament.name} - New Run`} className="input" required />
        </div>
        <div>
          <p className="label">What do you want to copy?</p>
          <div className="space-y-1.5">
            {COPY_OPTIONS.map(([name, label]) => (
              <label key={name} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name={name} defaultChecked className="h-4 w-4" />
                {label}
              </label>
            ))}
          </div>
        </div>
        <div className="rounded-xl bg-background p-3 text-sm text-muted">
          <p className="font-semibold text-foreground">Always reset:</p>
          Scores · Leaderboard · Check-in status · Bracket results · Champion
        </div>
        <div className="flex gap-2">
          <a href={`/admin/tournaments/${id}`} className="btn-secondary flex-1 justify-center">Cancel</a>
          <button type="submit" className="btn-primary flex-1">Clone and Start New Tournament</button>
        </div>
      </form>
    </div>
  );
}

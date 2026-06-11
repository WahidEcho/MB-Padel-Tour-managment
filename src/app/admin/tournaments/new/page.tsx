import { createTournament } from "../actions";

export default function NewTournamentPage() {
  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h1 className="text-2xl font-bold">New Tournament</h1>
      <form action={createTournament} className="card space-y-4 p-6">
        <div>
          <label className="label" htmlFor="name">Tournament name</label>
          <input id="name" name="name" required className="input" placeholder="Move Beyond Cup" />
        </div>
        <div>
          <label className="label" htmlFor="courts">Number of courts (1–20)</label>
          <input id="courts" name="courts" type="number" min={1} max={20} defaultValue={2} className="input" />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="is_demo" className="h-4 w-4" />
          Demo / training tournament (for referee training and screen testing)
        </label>
        <p className="text-xs text-muted">
          Default padel rules are applied: 1 set to 6 games, advantage scoring, tie-break at 6-6.
          You can change everything in Settings afterwards.
        </p>
        <button type="submit" className="btn-primary w-full">Create Tournament</button>
      </form>
    </div>
  );
}

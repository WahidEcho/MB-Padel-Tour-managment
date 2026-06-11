import { notFound } from "next/navigation";
import { getCourts, getScreenSettings, getTournament } from "@/lib/data";
import AutoRefresh from "@/components/AutoRefresh";
import { updateScreen } from "./actions";

export const dynamic = "force-dynamic";

const MODES: [string, string, string][] = [
  ["leaderboard", "📊 Leaderboard", "Group standings tables"],
  ["all_live", "🎾 All live matches", "Every live court"],
  ["live_court", "🏟 One court", "Pick the court below"],
  ["bracket", "🏆 Bracket", "Knockout tree"],
  ["winner", "🥇 Winner screen", "Champion / runner-up / third"],
  ["sponsors", "🤝 Sponsors", "Rotating sponsor logos"],
];

export default async function ControlPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tournament = await getTournament(id);
  if (!tournament) notFound();
  const [settings, courts] = await Promise.all([getScreenSettings(id), getCourts(id)]);

  return (
    <div className="space-y-4">
      <AutoRefresh seconds={10} />
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">{tournament.name} — TV control</h1>
        <a href={`/t/${tournament.slug}/screen`} target="_blank" className="btn-secondary text-xs">
          Open TV screen ↗
        </a>
      </div>
      <p className="text-sm text-muted">
        The TV screen updates itself within ~5 seconds of any change here.
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {MODES.map(([mode, label, hint]) => (
          <form key={mode} action={updateScreen}>
            <input type="hidden" name="tournament_id" value={id} />
            <input type="hidden" name="display_mode" value={mode} />
            <button
              className={`card w-full text-left transition hover:border-accent ${
                settings.display_mode === mode ? "border-accent bg-accent/10" : ""
              }`}
            >
              <p className="font-bold">{label}</p>
              <p className="text-xs text-muted">{hint}</p>
            </button>
          </form>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <form action={updateScreen} className="card space-y-2">
          <input type="hidden" name="tournament_id" value={id} />
          <label className="label">Focus court (for “One court”)</label>
          <select name="focus_court_id" defaultValue={settings.focus_court_id ?? ""} className="input">
            <option value="">All courts</option>
            {courts.map((c) => (
              <option key={c.id} value={c.id}>{c.court_name}</option>
            ))}
          </select>
          <button className="btn-secondary text-xs">Apply</button>
        </form>

        <form action={updateScreen} className="card space-y-2">
          <input type="hidden" name="tournament_id" value={id} />
          <label className="label">Screen theme</label>
          <select name="theme" defaultValue={settings.theme} className="input">
            <option value="dark">Dark (recommended for TV)</option>
            <option value="light">Light</option>
          </select>
          <button className="btn-secondary text-xs">Apply</button>
        </form>

        <form action={updateScreen} className="card space-y-2">
          <input type="hidden" name="tournament_id" value={id} />
          <label className="label">Sponsor rotation (seconds)</label>
          <input
            name="sponsor_rotation_seconds"
            type="number"
            min={3}
            defaultValue={settings.sponsor_rotation_seconds}
            className="input"
          />
          <button className="btn-secondary text-xs">Apply</button>
        </form>
      </div>
    </div>
  );
}

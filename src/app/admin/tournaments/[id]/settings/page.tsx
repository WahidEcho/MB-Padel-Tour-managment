import { notFound } from "next/navigation";
import { getCourts, getTournament } from "@/lib/data";
import ConfirmSubmit from "@/components/ConfirmSubmit";
import { addCourt, removeCourt, updateGeneral } from "./actions";
import BrandingForm from "./BrandingForm";
import ScoringRulesForm from "./ScoringRulesForm";
import SessionRowNotice from "../SessionRowNotice";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tournament = await getTournament(id);
  if (!tournament) notFound();
  const courts = await getCourts(id);
  const s = tournament.scoring_config;
  const f = tournament.format_config;
  const b = tournament.branding_config;

  if (tournament.kind !== "tournament") {
    // A session shares its wall's branding and its courts with these tools; its
    // name, match rules and court removals are the session's own.
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="lg:col-span-2">
          <SessionRowNotice tournamentId={id} tool="Name and match rules" />
        </div>
        <div className="card space-y-3">
          <h2 className="font-bold">Courts ({courts.length}/20)</h2>
          <ul className="space-y-1">
            {courts.map((c) => (
              <li key={c.id} className="rounded-lg bg-background px-3 py-1.5 text-sm font-semibold">
                {c.court_name}
              </li>
            ))}
          </ul>
          <form action={addCourt} className="flex gap-2">
            <input type="hidden" name="tournament_id" value={id} />
            <input name="court_name" className="input" placeholder={`Court ${courts.length + 1}`} required />
            <button className="btn-secondary whitespace-nowrap">Add court</button>
          </form>
        </div>
        <BrandingForm tournamentId={id} branding={b} />
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <form action={updateGeneral} className="card space-y-3">
        <h2 className="font-bold">General</h2>
        <input type="hidden" name="tournament_id" value={id} />
        <div>
          <label className="label">Tournament name</label>
          <input name="name" defaultValue={tournament.name} className="input" required />
        </div>
        <div>
          <label className="label">Lower-third banner (TV screens)</label>
          <input name="lower_third_text" defaultValue={tournament.lower_third_text} className="input" />
          <p className="mt-1 text-xs text-muted">Example: “Badya Padel Tournament | Powered by Move Beyond”</p>
        </div>
        <button className="btn-primary">Save general settings</button>
      </form>

      <ScoringRulesForm
        tournamentId={id}
        scoring={s}
        format={f}
        plateEnabled={Boolean(f.tiers?.plate?.enabled)}
        sport={tournament.sport}
      />

      <div className="card space-y-3">
        <h2 className="font-bold">Courts ({courts.length}/20)</h2>
        <ul className="space-y-1">
          {courts.map((c) => (
            <li key={c.id} className="flex items-center justify-between rounded-lg bg-background px-3 py-1.5 text-sm">
              <span className="font-semibold">{c.court_name}</span>
              <form action={removeCourt}>
                <input type="hidden" name="tournament_id" value={id} />
                <input type="hidden" name="court_id" value={c.id} />
                <ConfirmSubmit className="text-xs text-danger" message={`Remove ${c.court_name}?`}>
                  Remove
                </ConfirmSubmit>
              </form>
            </li>
          ))}
        </ul>
        <form action={addCourt} className="flex gap-2">
          <input type="hidden" name="tournament_id" value={id} />
          <input name="court_name" className="input" placeholder={`Court ${courts.length + 1}`} required />
          <button className="btn-secondary whitespace-nowrap">Add court</button>
        </form>
      </div>

      <BrandingForm tournamentId={id} branding={b} />
    </div>
  );
}

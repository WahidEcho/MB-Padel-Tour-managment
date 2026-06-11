import { notFound } from "next/navigation";
import { getCourts, getTournament } from "@/lib/data";
import ConfirmSubmit from "@/components/ConfirmSubmit";
import { addCourt, removeCourt, updateGeneral, updateScoring, uploadBranding } from "./actions";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tournament = await getTournament(id);
  if (!tournament) notFound();
  const courts = await getCourts(id);
  const s = tournament.scoring_config;
  const f = tournament.format_config;
  const b = tournament.branding_config;

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

      <form action={updateScoring} className="card space-y-3">
        <h2 className="font-bold">Scoring &amp; format rules</h2>
        <input type="hidden" name="tournament_id" value={id} />
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label">Sets to win match</label>
            <input name="setsToWinMatch" type="number" min={1} max={3} defaultValue={s.setsToWinMatch} className="input" />
          </div>
          <div>
            <label className="label">Games to win set</label>
            <input name="gamesToWinSet" type="number" min={1} max={9} defaultValue={s.gamesToWinSet} className="input" />
          </div>
          <div>
            <label className="label">Tie-break at games</label>
            <input name="tiebreakAtGames" type="number" min={1} max={9} defaultValue={s.tiebreakAtGames} className="input" />
          </div>
          <div>
            <label className="label">Tie-break target points</label>
            <input name="tiebreakTargetPoints" type="number" min={5} max={15} defaultValue={s.tiebreakTargetPoints} className="input" />
          </div>
          <div>
            <label className="label">Walkover score</label>
            <input name="walkoverScore" defaultValue={s.walkoverScore} className="input" />
          </div>
          <div>
            <label className="label">Qualify per group</label>
            <input name="qualifyPerGroup" type="number" min={1} max={4} defaultValue={f.qualifyPerGroup} className="input" />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="tiebreakEnabled" defaultChecked={s.tiebreakEnabled} className="h-4 w-4" />
          Tie-break enabled
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="tiebreakWinByTwo" defaultChecked={s.tiebreakWinByTwo} className="h-4 w-4" />
          Tie-break win by two
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="thirdPlaceMatch" defaultChecked={f.thirdPlaceMatch} className="h-4 w-4" />
          Third-place match
        </label>
        <button className="btn-primary">Save scoring rules</button>
      </form>

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

      <form action={uploadBranding} className="card space-y-3">
        <h2 className="font-bold">Branding</h2>
        <input type="hidden" name="tournament_id" value={id} />
        {(
          [
            ["move_beyond_logo", "Move Beyond logo", b.moveBeyondLogoUrl],
            ["client_logo", "Client/place logo", b.clientLogoUrl],
            ["event_logo", "Event logo", b.eventLogoUrl],
            ["background", "Background image", b.backgroundUrl],
          ] as const
        ).map(([field, label, url]) => (
          <div key={field} className="flex items-center gap-3">
            {url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={url} alt={label} className="h-10 w-10 rounded-lg border border-border object-contain" />
            ) : (
              <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted">—</span>
            )}
            <div className="flex-1">
              <label className="label">{label}</label>
              <input type="file" name={field} accept="image/*" className="input text-xs" />
            </div>
          </div>
        ))}
        <div>
          <label className="label">Sponsor logos (multiple, rotate on TV)</label>
          <input type="file" name="sponsor_logos" accept="image/*" multiple className="input text-xs" />
          {(b.sponsorLogoUrls?.length ?? 0) > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {b.sponsorLogoUrls!.map((u) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={u} src={u} alt="sponsor" className="h-8 rounded border border-border object-contain" />
              ))}
              <label className="flex items-center gap-1 text-xs text-danger">
                <input type="checkbox" name="clear_sponsors" /> clear all
              </label>
            </div>
          )}
        </div>
        <button className="btn-primary">Save branding</button>
      </form>
    </div>
  );
}

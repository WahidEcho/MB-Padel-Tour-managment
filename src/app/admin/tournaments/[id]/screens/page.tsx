import Link from "next/link";
import { notFound } from "next/navigation";
import { getCourts, getTournament, listScreens } from "@/lib/data";
import { can, currentRole } from "@/lib/auth";
import { ensureMainScreen } from "@/lib/screens";
import ConfirmSubmit from "@/components/ConfirmSubmit";
import { removeScreen } from "@/app/operator/tournaments/[id]/control/actions";

export const dynamic = "force-dynamic";

export default async function ScreensPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tournament = await getTournament(id);
  if (!tournament) notFound();
  await ensureMainScreen(id);

  const [screens, courts, role] = await Promise.all([listScreens(id), getCourts(id), currentRole()]);
  const base = `/t/${tournament.slug}`;
  const canDelete = can(role, "delete_screen");

  const coverage = (courtIds: string[]) => {
    if (!courtIds?.length) return "all courts";
    const names = courts.filter((c) => courtIds.includes(c.id)).map((c) => c.court_name);
    return names.length ? names.join(", ") : "no courts left";
  };

  const OTHER_LINKS: [string, string, string][] = [
    [`${base}`, "Public overview (mobile)", "Groups, live matches, upcoming matches — share this link with players."],
    [`${base}/leaderboard`, "Public leaderboard", "Full standings tables."],
    [`${base}/live`, "Live matches", "All live scoreboards."],
    [`${base}/bracket`, "Bracket", "Knockout tree."],
    [`${base}/winner`, "Winner screen", "Champion, runner-up, third place."],
  ];

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-bold">TV screens ({screens.length})</h2>
          <p className="text-sm text-muted">
            One link per wall, each showing its own courts. Open each link on that TV&rsquo;s browser
            and drive them from the{" "}
            <Link href={`/operator/tournaments/${id}/control`} className="font-semibold text-accent">
              control room
            </Link>
            , where new screens are added.
          </p>
        </div>

        <ul className="grid gap-3 sm:grid-cols-2">
          {screens.map((s) => {
            const url = s.screen_key === "main" ? `${base}/screen` : `${base}/screen/${s.screen_key}`;
            return (
              <li key={s.id} className="card space-y-1">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-bold">
                    {s.screen_name ?? (s.screen_key === "main" ? "Main screen" : s.screen_key)}
                  </p>
                  {s.screen_key === "main" && <span className="badge bg-border text-muted">default</span>}
                </div>
                <p className="text-xs text-muted">Shows {coverage(s.court_ids)}</p>
                <p className="break-all font-mono text-xs text-accent">{url}</p>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  <a href={url} target="_blank" rel="noreferrer" className="btn-secondary text-xs">
                    Open ↗
                  </a>
                  <Link href={`/operator/tournaments/${id}/control/${s.screen_key}`} className="btn-secondary text-xs">
                    Control
                  </Link>
                  {canDelete && s.screen_key !== "main" && (
                    <form action={removeScreen}>
                      <input type="hidden" name="tournament_id" value={id} />
                      <input type="hidden" name="screen_key" value={s.screen_key} />
                      <ConfirmSubmit
                        className="btn-secondary text-xs text-danger"
                        message={`Delete “${s.screen_name ?? s.screen_key}”? Any TV open on that link will stop showing this tournament.`}
                      >
                        Delete
                      </ConfirmSubmit>
                    </form>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-bold">Other public links</h2>
        <p className="text-sm text-muted">Read-only and self-refreshing. Safe to share with players.</p>
        <ul className="grid gap-3 sm:grid-cols-2">
          {OTHER_LINKS.map(([href, title, hint]) => (
            <li key={href} className="card space-y-1">
              <p className="font-bold">{title}</p>
              <p className="text-xs text-muted">{hint}</p>
              <p className="break-all font-mono text-xs text-accent">{href}</p>
              <a href={href} target="_blank" rel="noreferrer" className="btn-secondary mt-1 text-xs">
                Open ↗
              </a>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

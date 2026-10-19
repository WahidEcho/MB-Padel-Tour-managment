/* eslint-disable @next/next/no-img-element -- local flag SVGs */
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/supabase";
import { requireStaff, requireTournamentPage } from "@/lib/guard";
import { staffCan } from "@/lib/auth";
import ConfirmSubmit from "@/components/ConfirmSubmit";
import { courtCodeEvent } from "@/lib/orgs/courtCodes";
import { coachCodeWorks, coachCodesOf, coachDevicesByCode, coachEventTeams } from "@/lib/coaches/server";
import { nationByCode } from "@/lib/tennis/nations";
import { createCoachCodesAction, regenerateCoachCodeAction, revokeCoachCodeAction } from "./actions";

export const dynamic = "force-dynamic";

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "Africa/Cairo", dateStyle: "medium", timeStyle: "short" }) : "—";

/**
 * Team coaches (migration 0037): one access code per team (a nation in one event), for
 * the head coach and every assistant alike. One click makes a code for every team of the
 * event (both events of its group), the list revokes or replaces one, and each team has a
 * printable card (QR + code + instructions, /qr/coaches). Admins only. Docs: docs/coaches.md.
 */
export default async function TeamCoachesPage({ searchParams }: { searchParams: Promise<{ event?: string; made?: string }> }) {
  const { event, made } = await searchParams;
  const staff = await requireStaff(["admin"], "/admin/org/coaches");
  if (!staffCan(staff, "manage_coaches")) notFound();

  if (!event) {
    const { data } = await db()
      .from("tournaments")
      .select("id, name, status, event_group_id, format_config")
      .eq("organization_id", staff.orgId)
      .eq("kind", "tournament")
      .in("status", ["draft", "active"])
      .order("created_at", { ascending: false })
      .limit(100);
    const ts = (data ?? []) as { id: string; name: string; status: string; event_group_id: string | null; format_config: { ties?: unknown } | null }[];
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Team coaches</h1>
        <p className="text-sm text-muted">
          Each team gets one coach code: the head coach and every assistant sign in with it, in the Move Score app or on the web, and see only their own team. Pick the event; when it is part of an event group, both events are on one page.
        </p>
        <div className="space-y-2">
          {ts.map((t) => (
            <Link key={t.id} href={`/admin/org/coaches?event=${t.id}`} className="card flex items-center justify-between hover:border-accent" data-testid="coach-event">
              <span className="font-semibold">{t.name}</span>
              <span className="text-xs text-muted">{t.event_group_id ? "event group" : t.status}{t.format_config?.ties ? " · nations" : ""}</span>
            </Link>
          ))}
          {ts.length === 0 && <p className="card p-6 text-center text-muted">No draft or active events.</p>}
        </div>
      </div>
    );
  }

  // The event's own organisation decides (another organisation's: 404).
  await requireTournamentPage(event, ["admin"], `/admin/org/coaches?event=${event}`);
  const ev = await courtCodeEvent(staff.orgId, event);
  if (!ev) notFound();
  const [teams, codes] = await Promise.all([coachEventTeams(ev), coachCodesOf(staff.orgId, ev)]);
  const live = codes.filter((c) => coachCodeWorks(c));
  const devices = await coachDevicesByCode(staff.orgId, live.map((c) => c.id));
  const missing = teams.filter((t) => t.team_status !== "withdrawn" && !live.some((c) => c.team_id === t.id)).length;
  const byTournament = ev.tournaments.map((t) => ({ ...t, teams: teams.filter((x) => x.tournament_id === t.id) }));

  return (
    <div className="space-y-4">
      <p className="text-xs"><Link href="/admin/org/coaches" className="text-muted hover:text-foreground">← Team coaches</Link></p>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">Team coaches · {ev.title}</h1>
          <p className="max-w-3xl text-sm text-muted">
            One code per team. Coaches see their own team only: its group table, every tie with court and time, their own line-ups once the referee enters them, live scores and match logs of their own rubbers, and where the team goes after the groups. They cannot score, change line-ups or call the master referee.
            Revoking or replacing a code signs every device out on its next request.
          </p>
        </div>
        <Link href="/admin/org/referees" className="btn-secondary text-sm">Referees</Link>
      </div>

      <form action={createCoachCodesAction} className="card flex flex-wrap items-center gap-3">
        <input type="hidden" name="tournament_id" value={ev.tournamentId} />
        <button className="btn-primary" disabled={missing === 0} data-testid="create-coach-codes">
          {missing === 0 ? "Every team has a code" : `Create a code for every team (${missing})`}
        </button>
        {live.length > 0 && (
          <Link href={`/qr/coaches?event=${ev.tournamentId}`} className="btn-secondary" target="_blank" data-testid="print-coach-cards">
            Print all cards ({live.length})
          </Link>
        )}
        <span className="text-xs text-muted">Codes work until the team&apos;s event ends{ev.endsOn ? ` (last day ${ev.endsOn})` : ""}.</span>
      </form>
      {made && Number(made) > 0 && <p className="text-sm font-semibold text-success" data-testid="coach-codes-made">{made} new {made === "1" ? "code" : "codes"}. Print the cards and hand one to each team.</p>}

      {byTournament.map((t) => (
        <section key={t.id} className="space-y-2">
          <h2 className="label">{t.name}</h2>
          <div className="overflow-x-auto rounded-[20px] border border-border">
            <table className="w-full text-sm" data-testid="coach-codes">
              <thead className="bg-card text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2">Team</th>
                  <th className="px-3 py-2">Code</th>
                  <th className="px-3 py-2">Signed in</th>
                  <th className="px-3 py-2">Expires</th>
                  <th className="px-3 py-2">Last used</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {t.teams.map((team) => {
                  const code = live.find((c) => c.team_id === team.id);
                  const ended = codes.filter((c) => c.team_id === team.id && !coachCodeWorks(c)).length;
                  const iso2 = team.iso2 ?? nationByCode(team.nation_code)?.iso2 ?? null;
                  const d = code ? devices.get(code.id) : undefined;
                  return (
                    <tr key={team.id} className="border-t border-border" data-testid="coach-code-row">
                      <td className="px-3 py-2">
                        <span className="flex items-center gap-2 font-semibold">
                          {iso2 && <img src={`/flags/${iso2}.svg`} alt="" className="h-4 w-6 rounded-sm object-cover shadow" />}
                          {team.team_name}
                          {team.nation_code && <span className="text-xs font-normal text-muted">{team.nation_code}</span>}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {code ? <span className="text-success">working</span> : <span className="text-muted">no working code</span>}
                        {ended > 0 && <span className="text-muted"> · {ended} ended</span>}
                      </td>
                      <td className="px-3 py-2 text-xs" data-testid="coach-devices">{d ? `${d.n} ${d.n === 1 ? "device" : "devices"} · ${when(d.last)}` : "—"}</td>
                      <td className="px-3 py-2 text-xs">{code ? when(code.expires_at) : "—"}</td>
                      <td className="px-3 py-2 text-xs">{when(code?.last_used_at ?? null)}</td>
                      <td className="px-3 py-2 text-right">
                        {code && (
                          <div className="flex justify-end gap-2">
                            <Link href={`/qr/coaches?event=${ev.tournamentId}&team=${team.id}`} target="_blank" className="btn-secondary text-xs" data-testid="print-coach-card">
                              Card
                            </Link>
                            <form action={regenerateCoachCodeAction}>
                              <input type="hidden" name="code_id" value={code.id} />
                              <ConfirmSubmit message={`A new code for ${team.team_name}? The old one stops working on its next request (every coach of the team signs in again). Print the new card.`} className="btn-secondary text-xs">
                                New code
                              </ConfirmSubmit>
                            </form>
                            <form action={revokeCoachCodeAction}>
                              <input type="hidden" name="code_id" value={code.id} />
                              <ConfirmSubmit message={`Revoke ${team.team_name}'s coach code? Every device signed in with it is signed out on its next request.`} className="btn-secondary text-xs text-danger">
                                Revoke
                              </ConfirmSubmit>
                            </form>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {t.teams.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-6 text-center text-muted">No teams in this event yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

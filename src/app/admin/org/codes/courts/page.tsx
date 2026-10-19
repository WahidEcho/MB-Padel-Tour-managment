import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/supabase";
import { requireStaff, requireTournamentPage } from "@/lib/guard";
import { can } from "@/lib/auth";
import ConfirmSubmit from "@/components/ConfirmSubmit";
import { codeWorks, courtCodeEvent, courtCodesOf, eventCourts } from "@/lib/orgs/courtCodes";
import { courtKey } from "@/lib/orgs/courtScope";
import { revokeEventCode } from "../actions";
import { createCourtCodesAction, regenerateCourtCodeAction } from "./actions";

export const dynamic = "force-dynamic";

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "Africa/Cairo", dateStyle: "medium", timeStyle: "short" }) : "—";

/**
 * Court codes (migration 0034): one referee code per physical court of an event
 * (both events of its group share "Court 1"), a list with revoke, and the printable
 * QR sheet (/qr/courts). A referee who enters a court's code, or scans its QR,
 * sees and scores only that court's matches.
 */
export default async function CourtCodesPage({ searchParams }: { searchParams: Promise<{ event?: string; made?: string }> }) {
  const { event, made } = await searchParams;
  const staff = await requireStaff(["admin", "manager"], "/admin/org/codes/courts");
  if (!can(staff.role, "manage_codes")) notFound();

  if (!event) {
    const { data } = await db()
      .from("tournaments")
      .select("id, name, status, event_group_id")
      .eq("organization_id", staff.orgId)
      .eq("kind", "tournament")
      .in("status", ["draft", "active"])
      .order("created_at", { ascending: false })
      .limit(100);
    const ts = (data ?? []) as { id: string; name: string; status: string; event_group_id: string | null }[];
    return (
      <div className="space-y-4">
        <p className="text-xs"><Link href="/admin/org/codes" className="text-muted hover:text-foreground">← Event codes</Link></p>
        <h1 className="text-2xl font-bold">Court codes</h1>
        <p className="text-sm text-muted">Pick the event. When it is part of an event group, one code covers that court in every event of the group.</p>
        <div className="space-y-2">
          {ts.map((t) => (
            <Link key={t.id} href={`/admin/org/codes/courts?event=${t.id}`} className="card flex items-center justify-between hover:border-accent" data-testid="court-codes-event">
              <span className="font-semibold">{t.name}</span>
              <span className="text-xs text-muted">{t.event_group_id ? "event group" : t.status}</span>
            </Link>
          ))}
          {ts.length === 0 && <p className="card p-6 text-center text-muted">No draft or active events.</p>}
        </div>
      </div>
    );
  }

  // The event's own organisation decides (another organisation's: 404).
  await requireTournamentPage(event, ["admin", "manager"], `/admin/org/codes/courts?event=${event}`);
  const ev = await courtCodeEvent(staff.orgId, event);
  if (!ev) notFound();
  const [courts, codes] = await Promise.all([eventCourts(ev), courtCodesOf(staff.orgId, ev)]);
  const working = codes.filter((c) => codeWorks(c));
  const byCourt = new Map<string, typeof codes>();
  for (const c of codes) byCourt.set(courtKey(c.court_name), [...(byCourt.get(courtKey(c.court_name)) ?? []), c]);
  const missing = courts.filter((c) => !working.some((w) => courtKey(w.court_name) === c.key)).length;
  const back = `/admin/org/codes/courts?event=${ev.tournamentId}`;

  return (
    <div className="space-y-4">
      <p className="text-xs"><Link href="/admin/org/codes/courts" className="text-muted hover:text-foreground">← Court codes</Link></p>
      <div>
        <h1 className="text-2xl font-bold">Court codes · {ev.title}</h1>
        <p className="text-sm text-muted">
          {ev.tournaments.length > 1 ? `Both events: ${ev.tournaments.map((t) => t.name).join(" and ")}. ` : ""}
          A referee who enters a court&apos;s code, or scans the QR code at that court, sees and scores only that court&apos;s matches today.
          Revoking a code signs its phones out on their next request; points already on a phone stay queued until a code is entered again.
        </p>
      </div>

      <form action={createCourtCodesAction} className="card flex flex-wrap items-end gap-3">
        <input type="hidden" name="tournament_id" value={ev.tournamentId} />
        <div>
          <label className="label" htmlFor="court-days">Works until</label>
          <select id="court-days" name="expires" className="input" defaultValue={ev.endsOn ? "event_end" : ""}>
            {ev.endsOn && <option value="event_end">The event ends ({ev.endsOn})</option>}
            <option value="">Never (revoke by hand)</option>
            <option value="7">After a week</option>
          </select>
        </div>
        <button className="btn-primary" disabled={missing === 0} data-testid="create-court-codes">
          {missing === 0 ? "Every court has a code" : `Create a code for every court (${missing})`}
        </button>
        {working.length > 0 && (
          <Link href={`/qr/courts?event=${ev.tournamentId}`} className="btn-secondary" target="_blank" data-testid="print-court-sheet">
            Print QR sheet ({working.length} {working.length === 1 ? "page" : "pages"})
          </Link>
        )}
      </form>
      {made && Number(made) > 0 && <p className="text-sm font-semibold text-success" data-testid="court-codes-made">{made} new {made === "1" ? "code" : "codes"}. Print the QR sheet for the courts.</p>}

      <div className="overflow-x-auto rounded-[20px] border border-border">
        <table className="w-full text-sm" data-testid="court-codes">
          <thead className="bg-card text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-3 py-2">Court</th>
              <th className="px-3 py-2">Code</th>
              <th className="px-3 py-2">Created</th>
              <th className="px-3 py-2">Expires</th>
              <th className="px-3 py-2">Last used</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {courts.map((court) => {
              const list = byCourt.get(court.key) ?? [];
              const live = list.find((c) => codeWorks(c));
              const ended = list.filter((c) => !codeWorks(c)).length;
              return (
                <tr key={court.key} className="border-t border-border" data-testid="court-code-row">
                  <td className="px-3 py-2 font-semibold">{court.name}</td>
                  <td className="px-3 py-2 text-xs">
                    {live ? (live.label ?? "Referee") : <span className="text-muted">no working code</span>}
                    {ended > 0 && <span className="text-muted"> · {ended} ended</span>}
                  </td>
                  <td className="px-3 py-2 text-xs">{when(live?.created_at ?? null)}</td>
                  <td className="px-3 py-2 text-xs">{live ? (live.expires_at ? when(live.expires_at) : "never") : "—"}</td>
                  <td className="px-3 py-2 text-xs">{when(live?.last_used_at ?? null)}</td>
                  <td className="px-3 py-2 text-right">
                    {live && (
                      <div className="flex justify-end gap-2">
                      <a href={`/qr/courts/share?event=${ev.tournamentId}&court=${encodeURIComponent(court.name)}`} download className="btn-secondary text-xs" data-testid="share-court-card" title="A branded image of this court's QR card (PNG) to send">
                        Share
                      </a>
                      <form action={regenerateCourtCodeAction}>
                        <input type="hidden" name="code_id" value={live.id} />
                        <ConfirmSubmit message={`A new code for ${court.name}? The old one stops working on its next request; print ${court.name}'s page again.`} className="btn-secondary text-xs">
                          New code
                        </ConfirmSubmit>
                      </form>
                      <form action={revokeEventCode}>
                        <input type="hidden" name="code_id" value={live.id} />
                        <input type="hidden" name="back" value={back} />
                        <ConfirmSubmit message={`Revoke ${court.name}'s code? Its referee is signed out on the next request. Create a new one and print its page again.`} className="btn-secondary text-xs text-danger">
                          Revoke
                        </ConfirmSubmit>
                      </form>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {courts.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-muted">This event has no courts yet. Add them on the event&apos;s Courts tab.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

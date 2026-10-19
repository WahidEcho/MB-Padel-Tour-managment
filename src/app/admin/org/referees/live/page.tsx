import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/supabase";
import { requireStaff } from "@/lib/guard";
import { can } from "@/lib/auth";
import AutoRefresh from "@/components/AutoRefresh";
import { onCourtNow, signInHistory } from "@/lib/referees/server";
import { ON_COURT_MINUTES } from "@/lib/referees/rules";

export const dynamic = "force-dynamic";

const tz = "Africa/Cairo";
const at = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { timeZone: tz, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return m < 1 ? "just now" : `${m} min ago`;
};
const expired = (iso: string) => Date.parse(iso) <= Date.now();
const VIA: Record<string, string> = { web: "web console", app: "app", app_legacy: "app 1.0.1" };
const ENDED: Record<string, string> = { signed_out: "signed out", replaced: "moved to another court", pin_reset: "PIN reset", removed: "removed" };

/**
 * "On court now" (migration 0035): which referee is signed in on which court right now
 * (seen in the last ON_COURT_MINUTES minutes), the master referees on duty, the
 * sign-in history, and what the named referees did (the audit log, with their names).
 */
export default async function OnCourtNowPage() {
  const staff = await requireStaff(["admin", "manager"], "/admin/org/referees/live");
  if (!can(staff.role, "manage_referees")) notFound();
  const [now, history, { data: actions }] = await Promise.all([
    onCourtNow(staff.orgId),
    signInHistory(staff.orgId, 80),
    db()
      .from("audit_logs")
      .select("id, created_at, action, actor_name, entity_type, entity_id, new_value")
      .eq("organization_id", staff.orgId)
      .not("actor_referee_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(80),
  ]);
  const rows = (actions ?? []) as { id: string; created_at: string; action: string; actor_name: string | null; entity_type: string | null; entity_id: string | null; new_value: Record<string, unknown> | null }[];

  return (
    <div className="space-y-6">
      <AutoRefresh seconds={15} />
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-xs text-muted"><Link href="/admin/org/referees" className="underline">Referees</Link></p>
          <h1 className="text-2xl font-bold">On court now</h1>
          <p className="text-sm text-muted">Signed in with their PIN and seen in the last {ON_COURT_MINUTES} minutes.</p>
        </div>
        <Link href="/admin/org/referees/calls" className="btn-secondary text-sm">Calls for assistance</Link>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="on-court-now">
        {now.courts.map((c) => (
          <div key={c.key} className="card space-y-1" data-testid="on-court" data-court={c.court}>
            <p className="text-xs font-semibold uppercase tracking-widest text-accent">{c.court}</p>
            {c.referees.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-2">
                <p className="font-bold" data-testid="on-court-referee">{r.name}</p>
                <p className="text-xs text-muted">since {at(r.since)} · seen {ago(r.lastSeen)} · {VIA[r.via] ?? r.via}</p>
              </div>
            ))}
          </div>
        ))}
        {now.courts.length === 0 && <p className="card p-6 text-center text-muted sm:col-span-2 lg:col-span-3">No referee is signed in on a court right now.</p>}
      </section>

      <section className="space-y-2">
        <h2 className="label">Master referees on duty</h2>
        <div className="flex flex-wrap gap-2" data-testid="masters-on-duty">
          {now.masters.map((m) => (
            <span key={m.id} className="badge bg-accent/15 text-accent">{m.name} · seen {ago(m.lastSeen)}</span>
          ))}
          {now.masters.length === 0 && <p className="text-sm text-muted">None signed in.</p>}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="label">What the referees did</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm" data-testid="referee-actions">
            <thead>
              <tr className="text-xs uppercase text-muted">
                <th className="px-2 py-1">When</th>
                <th className="px-2 py-1">Referee</th>
                <th className="px-2 py-1">Action</th>
                <th className="px-2 py-1">Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className="border-t border-border">
                  <td className="px-2 py-1 whitespace-nowrap">{at(a.created_at)}</td>
                  <td className="px-2 py-1 font-semibold">{a.actor_name}</td>
                  <td className="px-2 py-1">{a.action.toLowerCase().replace(/_/g, " ")}</td>
                  <td className="px-2 py-1 text-xs text-muted">
                    {a.entity_type === "match" && a.entity_id ? <Link href={`/referee/matches/${a.entity_id}/score`} className="underline">match</Link> : a.entity_type ?? ""}
                    {a.new_value && typeof a.new_value === "object" && "court" in a.new_value ? ` · ${String(a.new_value.court)}` : ""}
                    {a.new_value && typeof a.new_value === "object" && "applied" in a.new_value ? ` · ${String(a.new_value.applied)} points` : ""}
                    {/* An accepted line-up exception (ITF Reg. 43 / 50) says what was accepted. */}
                    {a.new_value && typeof a.new_value === "object" && "text" in a.new_value ? <span className="block text-foreground" data-testid="exception-text">{String(a.new_value.text)}</span> : null}
                    {a.new_value && typeof a.new_value === "object" && "reason" in a.new_value && a.new_value.reason ? <span className="block">Reason: {String(a.new_value.reason)}</span> : null}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-2 py-4 text-center text-muted">Nothing yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="label">Sign-ins</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm" data-testid="sign-in-history">
            <thead>
              <tr className="text-xs uppercase text-muted">
                <th className="px-2 py-1">Referee</th>
                <th className="px-2 py-1">Court</th>
                <th className="px-2 py-1">Signed in</th>
                <th className="px-2 py-1">Last seen</th>
                <th className="px-2 py-1">Ended</th>
              </tr>
            </thead>
            <tbody>
              {history.map((s) => (
                <tr key={s.id} className="border-t border-border">
                  <td className="px-2 py-1 font-semibold">{s.name}</td>
                  <td className="px-2 py-1">{s.court_name ?? (s.role === "master_referee" ? "Master referee (every court)" : "—")}</td>
                  <td className="px-2 py-1 whitespace-nowrap">{at(s.signed_in_at)} · {VIA[s.via] ?? s.via}</td>
                  <td className="px-2 py-1 whitespace-nowrap">{at(s.last_seen_at)}</td>
                  <td className="px-2 py-1 whitespace-nowrap text-muted">{s.ended_at ? `${at(s.ended_at)} · ${ENDED[s.end_reason ?? ""] ?? s.end_reason}` : expired(s.expires_at) ? "expired" : "—"}</td>
                </tr>
              ))}
              {history.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-2 py-4 text-center text-muted">No sign-ins yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

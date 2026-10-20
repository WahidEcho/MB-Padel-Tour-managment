import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/supabase";
import { requireStaff } from "@/lib/guard";
import { can } from "@/lib/auth";
import ConfirmSubmit from "@/components/ConfirmSubmit";
import { PIN_BRAKE_AUDIT, rosterOf } from "@/lib/referees/server";
import { REFEREE_ROLE_LABELS } from "@/lib/referees/rules";
import { removeRefereeAction } from "./actions";
import { MasterCodeForm, NewRefereeForm, ResetPinForm } from "./RefereeForms";

export const dynamic = "force-dynamic";

const working = (c: { revoked_at: string | null; expires_at: string | null }) => !c.revoked_at && !(c.expires_at && Date.parse(c.expires_at) <= Date.now());
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "Africa/Cairo", dateStyle: "medium", timeStyle: "short" }) : "—");

/**
 * The referee roster (migration 0035): each referee's own 4-digit PIN (shown once,
 * resettable), master referees and their personal codes. A court's code says which
 * court; the PIN says who. Docs: docs/referees.md.
 */
export default async function RefereesPage() {
  const staff = await requireStaff(["admin", "manager"], "/admin/org/referees");
  if (!can(staff.role, "manage_referees")) notFound();
  const [roster, { data: gRows }, { data: codeRows }, { data: brakeRows }] = await Promise.all([
    rosterOf(staff.orgId),
    db().from("event_groups").select("id, name").eq("organization_id", staff.orgId).order("created_at", { ascending: false }).limit(50),
    db()
      .from("organization_codes")
      .select("id, referee_id, event_group_id, expires_at, revoked_at, last_used_at")
      .eq("organization_id", staff.orgId)
      .eq("role", "master_referee")
      .order("created_at", { ascending: false })
      .limit(200),
    // Wrong-PIN alerts of the last day (src/lib/referees/server.ts alertOrgPinBrake).
    db()
      .from("audit_logs")
      .select("created_at, new_value")
      .eq("organization_id", staff.orgId)
      .eq("action", PIN_BRAKE_AUDIT)
      .gte("created_at", hoursAgo(24))
      .order("created_at", { ascending: false })
      .limit(10),
  ]);
  const brakes = (brakeRows ?? []) as { created_at: string; new_value: { wrong_pins?: number; window_minutes?: number; paused_until?: string } | null }[];
  const groups = (gRows ?? []) as { id: string; name: string }[];
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  const codes = (codeRows ?? []) as { id: string; referee_id: string; event_group_id: string | null; expires_at: string | null; revoked_at: string | null; last_used_at: string | null }[];
  const active = roster.filter((r) => r.status === "active");
  const removed = roster.filter((r) => r.status !== "active");

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">Referees</h1>
          <p className="text-sm text-muted">
            Each referee has their own 4-digit PIN. On court they scan the court&apos;s QR (or type its code), then their PIN: the code says which court, the PIN says who.
          </p>
        </div>
        <div className="flex gap-2 text-sm">
          <Link href="/admin/org/referees/live" className="btn-secondary" data-testid="on-court-link">On court now</Link>
          <Link href="/admin/org/referees/calls" className="btn-secondary" data-testid="calls-link">Calls for assistance</Link>
          <Link href="/admin/org/codes" className="btn-secondary">Court codes</Link>
        </div>
      </div>

      {brakes.length > 0 && (
        <section className="rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm" data-testid="pin-brake-banner" role="alert">
          <p className="font-bold text-danger">Too many wrong referee PINs</p>
          <p className="text-muted">
            {brakes[0].new_value?.wrong_pins ?? "Many"} wrong PINs within {brakes[0].new_value?.window_minutes ?? "?"} minutes (last {when(brakes[0].created_at)}). PIN sign-in on new devices was paused until{" "}
            {when(brakes[0].new_value?.paused_until ?? null)}; referees&apos; own devices from today kept working. If these were not your referees, give the affected referees a new PIN below.
          </p>
          {brakes.length > 1 && <p className="mt-1 text-xs text-muted">{brakes.length} alerts in the last 24 hours.</p>}
        </section>
      )}

      <NewRefereeForm groups={groups} />

      <section className="space-y-2">
        <h2 className="label">Active ({active.length})</h2>
        {active.map((r) => {
          const mine = codes.filter((c) => c.referee_id === r.id && working(c));
          return (
            <div key={r.id} className="card space-y-2" data-testid="referee-row" data-referee-id={r.id}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  {r.photo_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={r.photo_url} alt="" className="h-10 w-10 rounded-full object-cover" />
                  ) : (
                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent/15 font-bold text-accent">{r.name.slice(0, 1)}</span>
                  )}
                  <div>
                    <p className="font-bold">{r.name}</p>
                    <p className="text-xs text-muted">
                      <span className={r.role === "master_referee" ? "font-semibold text-accent" : ""}>{REFEREE_ROLE_LABELS[r.role]}</span>
                      {r.phone ? ` · ${r.phone}` : ""}
                      {` · ${r.event_group_id ? (groupName.get(r.event_group_id) ?? "one event group") : "every event"}`}
                      {` · PIN set ${when(r.pin_set_at)}`}
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <ResetPinForm refereeId={r.id} name={r.name} />
                  <form action={removeRefereeAction}>
                    <input type="hidden" name="referee_id" value={r.id} />
                    <ConfirmSubmit message={`Remove ${r.name}? Their PIN stops working at once.`} className="btn-secondary text-xs text-danger">Remove</ConfirmSubmit>
                  </form>
                </div>
              </div>
              {r.role === "master_referee" && (
                <div className="border-t border-border pt-2">
                  <p className="mb-1 text-xs text-muted">
                    {mine.length
                      ? `${mine.length} working master code${mine.length === 1 ? "" : "s"} (${mine.map((c) => (c.event_group_id ? (groupName.get(c.event_group_id) ?? "an event group") : "every open event")).join(", ")}; last used ${when(mine[0].last_used_at)}). Revoke on Event codes.`
                      : "No master code yet: make one, then give it to them with their PIN."}
                  </p>
                  <MasterCodeForm refereeId={r.id} groups={groups} defaultGroup={r.event_group_id} />
                </div>
              )}
            </div>
          );
        })}
        {active.length === 0 && <p className="card p-6 text-center text-muted">No referees yet. Add the first one above.</p>}
      </section>

      {removed.length > 0 && (
        <details className="card">
          <summary className="cursor-pointer text-sm font-semibold">Removed ({removed.length})</summary>
          <ul className="mt-2 space-y-1 text-sm text-muted">
            {removed.map((r) => (
              <li key={r.id}>{r.name} · {REFEREE_ROLE_LABELS[r.role]}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

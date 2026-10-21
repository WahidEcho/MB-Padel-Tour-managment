import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/supabase";
import { requireStaff } from "@/lib/guard";
import { can } from "@/lib/auth";
import AutoRefresh from "@/components/AutoRefresh";
import { callLog } from "@/lib/referees/assistance";
import { resolveCallAction } from "../actions";

export const dynamic = "force-dynamic";

const tz = "Africa/Cairo";
const at = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { timeZone: tz, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—");
const mins = (from: string, to: string | null) => (to ? `${Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000 / 60 * 10) / 10)} min` : "");
const STATUS: Record<string, string> = { open: "bg-danger/15 text-danger", acknowledged: "bg-warning/15 text-warning", resolved: "bg-success/15 text-success", cancelled: "bg-border text-muted" };

/**
 * Every call for assistance of the organisation (migration 0035), open and closed, with
 * its times: requested, acknowledged ("On my way", by whom), resolved. The organiser can
 * close an open one.
 */
export default async function AssistanceCallsPage() {
  const staff = await requireStaff(["admin", "manager"], "/admin/org/referees/calls");
  if (!can(staff.role, "manage_referees")) notFound();
  const [calls, { data: tRows }] = await Promise.all([
    callLog(staff.orgId),
    db().from("tournaments").select("id, name").eq("organization_id", staff.orgId).in("status", ["draft", "active", "completed"]).limit(200),
  ]);
  const tName = new Map(((tRows ?? []) as { id: string; name: string }[]).map((t) => [t.id, t.name]));
  const open = calls.filter((c) => c.status === "open" || c.status === "acknowledged").length;

  return (
    <div className="space-y-5">
      <AutoRefresh seconds={10} />
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-xs text-muted"><Link href="/admin/org/referees" className="underline">Referees</Link></p>
          <h1 className="text-2xl font-bold">Calls for assistance</h1>
          <p className="text-sm text-muted">{open ? `${open} open now.` : "None open now."} Every call, newest first.</p>
        </div>
        <Link href="/admin/org/referees/live" className="btn-secondary text-sm">On court now</Link>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-left text-sm" data-testid="calls-log">
          <thead>
            <tr className="text-xs uppercase text-muted">
              <th className="px-2 py-1">Court</th>
              <th className="px-2 py-1">Referee</th>
              <th className="px-2 py-1">Requested</th>
              <th className="px-2 py-1">Acknowledged</th>
              <th className="px-2 py-1">Resolved</th>
              <th className="px-2 py-1">Status</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((c) => (
              <tr key={c.id} className="border-t border-border align-top" data-testid="call-row" data-call-id={c.id}>
                <td className="px-2 py-1">
                  <p className="font-bold">{c.court_name}</p>
                  <p className="text-xs text-muted">{c.tournament_id ? (tName.get(c.tournament_id) ?? "") : ""}{c.taps > 1 ? ` · ${c.taps} taps` : ""}</p>
                </td>
                <td className="px-2 py-1">{c.requested_by_name}</td>
                <td className="px-2 py-1 whitespace-nowrap" data-testid="call-requested">{at(c.requested_at)}
                  <p className="text-xs text-muted">
                    {c.alerted} phone{c.alerted === 1 ? "" : "s"} alerted
                    {c.reminders_sent ? ` · ${c.reminders_sent} reminder window${c.reminders_sent === 1 ? "" : "s"}` : ""}
                  </p>
                  {c.escalated_at ? <p className="text-xs font-semibold text-danger" data-testid="call-escalated">Organiser alerted {at(c.escalated_at)}</p> : null}
                  {c.declined.length ? <p className="text-xs text-muted" data-testid="call-declined">Declined: {c.declined.join(", ")}</p> : null}
                </td>
                <td className="px-2 py-1 whitespace-nowrap" data-testid="call-acknowledged">
                  {c.acknowledged_at ? (
                    <>
                      {at(c.acknowledged_at)}
                      <p className="text-xs text-muted">{c.acknowledged_by_name} · after {mins(c.requested_at, c.acknowledged_at)}</p>
                    </>
                  ) : "—"}
                </td>
                <td className="px-2 py-1 whitespace-nowrap" data-testid="call-resolved">
                  {c.resolved_at ? (
                    <>
                      {at(c.resolved_at)}
                      <p className="text-xs text-muted">{c.resolved_by_name} · after {mins(c.requested_at, c.resolved_at)}</p>
                    </>
                  ) : "—"}
                </td>
                <td className="px-2 py-1">
                  <span className={`badge ${STATUS[c.status] ?? ""}`}>{c.status}</span>
                  {(c.status === "open" || c.status === "acknowledged") && (
                    <form action={resolveCallAction} className="mt-1">
                      <input type="hidden" name="call_id" value={c.id} />
                      <button className="btn-secondary text-xs">Mark resolved</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
            {calls.length === 0 && (
              <tr>
                <td colSpan={6} className="px-2 py-6 text-center text-muted">No calls yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

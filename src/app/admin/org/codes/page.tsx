import { db } from "@/lib/supabase";
import { requireStaff } from "@/lib/guard";
import { can } from "@/lib/auth";
import { notFound } from "next/navigation";
import ConfirmSubmit from "@/components/ConfirmSubmit";
import CodeForm from "./CodeForm";
import { revokeEventCode } from "./actions";

export const dynamic = "force-dynamic";

interface CodeRow {
  id: string;
  role: string;
  label: string | null;
  tournament_id: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

/** "revoked", "expired", or null while the code still works. */
function deadness(c: Pick<CodeRow, "revoked_at" | "expires_at">): string | null {
  if (c.revoked_at) return "revoked";
  return c.expires_at && Date.parse(c.expires_at) <= Date.now() ? "expired" : null;
}

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "Africa/Cairo", dateStyle: "medium", timeStyle: "short" }) : "—";

/** The organisation's event codes for referees and TV operators. Codes themselves are never shown again. */
export default async function EventCodesPage() {
  const staff = await requireStaff(["admin", "manager"], "/admin/org/codes");
  if (!can(staff.role, "manage_codes")) notFound();
  const [{ data: codeRows }, { data: tRows }] = await Promise.all([
    db()
      .from("organization_codes")
      .select("id, role, label, tournament_id, expires_at, revoked_at, last_used_at, created_at")
      .eq("organization_id", staff.orgId)
      .order("created_at", { ascending: false })
      .limit(200),
    db()
      .from("tournaments")
      .select("id, name, kind, status")
      .eq("organization_id", staff.orgId)
      .in("status", ["draft", "active"])
      .order("created_at", { ascending: false })
      .limit(200),
  ]);
  const codes = (codeRows ?? []) as CodeRow[];
  const tournaments = (tRows ?? []) as { id: string; name: string; kind: string }[];
  const nameOf = new Map(tournaments.map((t) => [t.id, t.name]));

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Event codes</h1>
      <p className="text-xs text-muted">
        Referees and screen operators sign in with a code instead of an account. A code can be limited to one event and
        can expire; revoking it signs out every phone and browser using it on their next request (points already scored
        on a phone stay queued until a new code is entered).
      </p>
      <CodeForm tournaments={tournaments.map((t) => ({ id: t.id, name: t.name }))} />
      <div className="overflow-x-auto rounded-[20px] border border-border">
        <table className="w-full text-sm" data-testid="codes">
          <thead className="bg-card text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-3 py-2">Code</th>
              <th className="px-3 py-2">Only for</th>
              <th className="px-3 py-2">Created</th>
              <th className="px-3 py-2">Expires</th>
              <th className="px-3 py-2">Last used</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {codes.map((c) => {
              const dead = deadness(c);
              return (
                <tr key={c.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <span className="font-semibold capitalize">{c.role}</span>
                    {c.label && <span className="text-muted"> · {c.label}</span>}
                  </td>
                  <td className="px-3 py-2 text-xs">{c.tournament_id ? (nameOf.get(c.tournament_id) ?? "an earlier event") : "every event"}</td>
                  <td className="px-3 py-2 text-xs">{when(c.created_at)}</td>
                  <td className="px-3 py-2 text-xs">{c.expires_at ? when(c.expires_at) : "never"}</td>
                  <td className="px-3 py-2 text-xs">{when(c.last_used_at)}</td>
                  <td className="px-3 py-2 text-right">
                    {dead ? (
                      <span className="badge bg-border text-muted">{dead}</span>
                    ) : (
                      <form action={revokeEventCode}>
                        <input type="hidden" name="code_id" value={c.id} />
                        <ConfirmSubmit message="Revoke this code? Everyone using it is signed out on their next request." className="btn-secondary text-xs text-danger">
                          Revoke
                        </ConfirmSubmit>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
            {codes.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-muted">No event codes yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

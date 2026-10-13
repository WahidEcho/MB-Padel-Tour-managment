import { notFound } from "next/navigation";
import { db } from "@/lib/supabase";
import { requireStaff } from "@/lib/guard";
import { staffCan } from "@/lib/auth";
import StateForm from "@/components/StateForm";
import { inviteState, INVITE_COLUMNS, type InviteRow } from "@/lib/orgs/invites";
import { mayAssignRole, mayRemoveMember, ORG_ROLES, ROLE_LABELS, type OrgRole } from "@/lib/orgs/roles";
import InviteForm from "./InviteForm";
import { changeMemberRole, removeMember, revokeInvite } from "./actions";

export const dynamic = "force-dynamic";

interface MemberRow {
  id: string;
  auth_user_id: string | null;
  invited_email: string | null;
  role: OrgRole;
  status: string;
  created_at: string;
  updated_at: string;
}

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "Africa/Cairo", dateStyle: "medium", timeStyle: "short" }) : "—";

/** The organisation's staff: members, their roles, and open invites. Owners and admins. */
export default async function MembersPage() {
  const staff = await requireStaff(["admin", "manager"], "/admin/org/members");
  if (!staffCan(staff, "manage_members") || staff.scopeTournamentId) notFound();
  const [{ data: memberRows }, { data: inviteRows }] = await Promise.all([
    db()
      .from("organization_members")
      .select("id, auth_user_id, invited_email, role, status, created_at, updated_at")
      .eq("organization_id", staff.orgId)
      .eq("status", "active")
      .order("created_at")
      .limit(500),
    db().from("organization_invites").select(INVITE_COLUMNS).eq("organization_id", staff.orgId).order("created_at", { ascending: false }).limit(100),
  ]);
  const members = (memberRows ?? []) as MemberRow[];
  const invites = ((inviteRows ?? []) as InviteRow[]).filter((i) => inviteState(i) === "pending");
  const owners = members.filter((m) => m.role === "owner").length;
  const actor = staff.orgRole;
  const grantable = ORG_ROLES.filter((r) => mayAssignRole(actor, null, r)).map((r) => ({ value: r, label: ROLE_LABELS[r] }));

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Members</h1>
      <p className="text-xs text-muted">
        People who run {staff.orgName} on Move Score, each with their own sign-in (Google, or email and password). Owners can
        give every role; admins can add managers, referees and screen operators. Removing someone takes effect on their next
        click. Referees and screen operators can also use an event code instead of an account.
      </p>

      <InviteForm roles={grantable} />

      <div className="overflow-x-auto rounded-[20px] border border-border">
        <table className="w-full text-sm" data-testid="members">
          <thead className="bg-card text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-3 py-2">Member</th>
              <th className="px-3 py-2">Role</th>
              <th className="px-3 py-2">Since</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const roles = ORG_ROLES.filter((r) => r === m.role || mayAssignRole(actor, m.role, r));
              const lastOwner = m.role === "owner" && owners <= 1;
              const me = m.auth_user_id !== null && m.auth_user_id === staff.userId;
              return (
                <tr key={m.id} className="border-t border-border align-top" data-testid="member-row">
                  <td className="px-3 py-2">
                    <span className="font-semibold">{m.invited_email ?? "Member"}</span>
                    {me && <span className="badge ml-2 bg-accent/15 text-accent">you</span>}
                  </td>
                  <td className="px-3 py-2">
                    {roles.length > 1 && !lastOwner ? (
                      <StateForm action={changeMemberRole} className="flex flex-wrap items-center gap-2">
                        <input type="hidden" name="member_id" value={m.id} />
                        <select name="role" defaultValue={m.role} className="input py-1 text-xs" aria-label="Role">
                          {roles.map((r) => (
                            <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                          ))}
                        </select>
                        <button className="btn-secondary text-xs">Save</button>
                      </StateForm>
                    ) : (
                      <span className="capitalize">{ROLE_LABELS[m.role]}{lastOwner ? " · the only owner" : ""}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">{when(m.created_at)}</td>
                  <td className="px-3 py-2 text-right">
                    {mayRemoveMember(actor, m.role) && !lastOwner && (
                      <StateForm action={removeMember} confirm={`Remove ${m.invited_email ?? "this member"}? They lose access on their next click.`}>
                        <input type="hidden" name="member_id" value={m.id} />
                        <button className="btn-secondary text-xs text-danger">Remove</button>
                      </StateForm>
                    )}
                  </td>
                </tr>
              );
            })}
            {members.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-muted">No members yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2 className="text-lg font-bold">Open invites</h2>
      <div className="overflow-x-auto rounded-[20px] border border-border">
        <table className="w-full text-sm" data-testid="invites">
          <thead className="bg-card text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-3 py-2">Email</th>
              <th className="px-3 py-2">Role</th>
              <th className="px-3 py-2">Expires</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {invites.map((i) => (
              <tr key={i.id} className="border-t border-border">
                <td className="px-3 py-2">{i.email}</td>
                <td className="px-3 py-2">{ROLE_LABELS[i.role]}</td>
                <td className="px-3 py-2 text-xs">{when(i.expires_at)}</td>
                <td className="px-3 py-2 text-right">
                  {mayAssignRole(actor, null, i.role) && (
                    <StateForm action={revokeInvite} confirm="Withdraw this invite? Its link stops working at once.">
                      <input type="hidden" name="invite_id" value={i.id} />
                      <button className="btn-secondary text-xs text-danger">Withdraw</button>
                    </StateForm>
                  )}
                </td>
              </tr>
            ))}
            {invites.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-muted">No open invites.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

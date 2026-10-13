"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requireScopedPermission, requireStaffPermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { normalizeEmail } from "@/lib/auth/password";
import { createHash } from "node:crypto";
import { takeRateLimit } from "@/lib/ratelimit";
import { createInvite, sendInviteEmail, withdrawInvitesOf } from "@/lib/orgs/invites";
import { isOrgRole, mayAssignRole, mayRemoveMember, ROLE_LABELS, wouldLeaveNoOwner, type OrgRole } from "@/lib/orgs/roles";
import type { FormState } from "@/components/StateForm";

const PATH = "/admin/org/members";

export type InviteFormState = { ok: true; link: string; email: string; role: string; emailed: boolean } | { ok: false; message: string } | null;

const LAST_OWNER = "An organisation must keep at least one owner. Make someone else owner first.";
/** At most this many invites an hour per organisation, and this many a day to one address. */
const INVITES_PER_ORG = { limit: 20, windowSeconds: 3600 };
const INVITES_PER_ADDRESS = { limit: 4, windowSeconds: 86_400 };
const OWNERS_ONLY = "Only an owner can give or change the owner and admin roles.";

async function activeOwners(orgId: string): Promise<number> {
  const { count } = await db()
    .from("organization_members")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("role", "owner")
    .eq("status", "active");
  return count ?? 0;
}

/**
 * Invites someone to the caller's own organisation (never one named in the form).
 * The link is shown once here and emailed; only its HMAC is stored.
 */
export async function inviteMember(_prev: InviteFormState, formData: FormData): Promise<InviteFormState> {
  const staff = await requireStaffPermission("manage_members");
  const role = String(formData.get("role") ?? "");
  const email = normalizeEmail(String(formData.get("email") ?? "")).slice(0, 254);
  if (!isOrgRole(role)) return { ok: false, message: "Pick a role." };
  if (!mayAssignRole(staff.orgRole, null, role)) return { ok: false, message: OWNERS_ONLY };
  const { data: already } = await db()
    .from("organization_members")
    .select("id")
    .eq("organization_id", staff.orgId)
    .eq("invited_email", email)
    .eq("status", "active")
    .limit(1);
  if (already?.length) return { ok: false, message: "That person is already a member. Change their role below instead." };
  // Brakes on invite email: per organisation, and per address across every organisation (hashed).
  const perOrg = await takeRateLimit({ key: `org-invite:${staff.orgId}`, ...INVITES_PER_ORG });
  if (!perOrg.allowed) return { ok: false, message: "Too many invites in the last hour. Try again later." };
  const perAddress = await takeRateLimit({ key: `org-invite-to:${createHash("sha256").update(`mb-invite-to:${email}`).digest("base64url").slice(0, 22)}`, ...INVITES_PER_ADDRESS });
  if (!perAddress.allowed) return { ok: false, message: "This address has had several invites today. Try again tomorrow, or send the link yourself." };
  const r = await createInvite({ organizationId: staff.orgId, email, role, createdBy: staff.userId, createdByRole: staff.orgRole });
  if (!r.ok) return r;
  const sent = await sendInviteEmail({
    inviteId: r.id,
    email: r.email,
    orgName: staff.orgName,
    role,
    inviter: `${ROLE_LABELS[staff.orgRole]} of ${staff.orgName}`,
    link: r.link,
    token: r.token,
  });
  // Never the link or its token: who, which role, whether the email went.
  await audit({ organization_id: staff.orgId, action: "INVITE_CREATED", entity_type: "organization_invite", entity_id: r.id, new_value: { role, emailed: sent.ok } });
  revalidatePath(PATH);
  return { ok: true, link: r.link, email: r.email, role, emailed: sent.ok };
}

/** Gives a member another role. The member row's own organisation decides, not anything posted with it. */
export async function changeMemberRole(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = String(formData.get("member_id") ?? "");
  const { staff } = await requireScopedPermission("manage_members", { member: id });
  const next = String(formData.get("role") ?? "");
  if (!isOrgRole(next)) return { ok: false, message: "Pick a role." };
  const { data } = await db().from("organization_members").select("id, role, status").eq("id", id).eq("organization_id", staff.orgId).maybeSingle();
  const member = data as { id: string; role: OrgRole; status: string } | null;
  if (!member || member.status !== "active") return { ok: false, message: "Not found" };
  if (member.role === next) return { ok: true, message: "No change." };
  if (!mayAssignRole(staff.orgRole, member.role, next)) return { ok: false, message: OWNERS_ONLY };
  if (wouldLeaveNoOwner(member.role, next, await activeOwners(staff.orgId))) return { ok: false, message: LAST_OWNER };
  const { error } = await db()
    .from("organization_members")
    .update({ role: next, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", staff.orgId);
  // The database keeps the last owner too (trigger organization_members_keep_owner).
  if (error) return { ok: false, message: /owner/.test(error.message) ? LAST_OWNER : "Could not change the role. Try again." };
  await audit({ organization_id: staff.orgId, action: "MEMBER_ROLE_CHANGED", entity_type: "organization_member", entity_id: id, old_value: { role: member.role }, new_value: { role: next } });
  revalidatePath(PATH);
  return { ok: true, message: `Now ${ROLE_LABELS[next].toLowerCase()}.` };
}

/** Removes a member. Takes effect on their next request (membership is re-read every time). */
export async function removeMember(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = String(formData.get("member_id") ?? "");
  const { staff } = await requireScopedPermission("manage_members", { member: id });
  const { data } = await db().from("organization_members").select("id, role, status, auth_user_id, invited_email").eq("id", id).eq("organization_id", staff.orgId).maybeSingle();
  const member = data as { id: string; role: OrgRole; status: string; auth_user_id: string | null; invited_email: string | null } | null;
  if (!member || member.status !== "active") return { ok: false, message: "Not found" };
  if (!mayRemoveMember(staff.orgRole, member.role)) return { ok: false, message: "Only an owner can remove an owner or an admin." };
  if (wouldLeaveNoOwner(member.role, "removed", await activeOwners(staff.orgId))) return { ok: false, message: LAST_OWNER };
  const { error } = await db()
    .from("organization_members")
    .update({ status: "removed", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", staff.orgId);
  if (error) return { ok: false, message: /owner/.test(error.message) ? LAST_OWNER : "Could not remove the member. Try again." };
  // Their open invites go with them: the ones they sent, and any to their own address.
  const withdrawn = await withdrawInvitesOf(staff.orgId, { authUserId: member.auth_user_id, email: member.invited_email });
  await audit({ organization_id: staff.orgId, action: "MEMBER_REMOVED", entity_type: "organization_member", entity_id: id, old_value: { role: member.role }, new_value: { invites_withdrawn: withdrawn } });
  revalidatePath(PATH);
  return { ok: true, message: "Removed." };
}

/** Withdraws an invite that has not been used: its link stops working at once. */
export async function revokeInvite(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = String(formData.get("invite_id") ?? "");
  const { staff } = await requireScopedPermission("manage_members", { invite: id });
  const { data } = await db().from("organization_invites").select("id, role").eq("id", id).eq("organization_id", staff.orgId).maybeSingle();
  const invite = data as { id: string; role: OrgRole } | null;
  if (!invite) return { ok: false, message: "Not found" };
  if (!mayAssignRole(staff.orgRole, null, invite.role)) return { ok: false, message: OWNERS_ONLY };
  const { data: changed } = await db()
    .from("organization_invites")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", staff.orgId)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .select("id");
  if (!changed?.length) return { ok: false, message: "That invite was already used or withdrawn." };
  await audit({ organization_id: staff.orgId, action: "INVITE_REVOKED", entity_type: "organization_invite", entity_id: id });
  revalidatePath(PATH);
  return { ok: true, message: "Invite withdrawn." };
}

"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requirePlatformPermission, type StaffPrincipal } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { normalizeEmail, isValidEmail } from "@/lib/auth/password";
import { randomBytes } from "node:crypto";
import { createInvite, sendInviteEmail } from "@/lib/orgs/invites";
import { orgNameRefusal } from "@/lib/orgs/names";
import { isOrgRole, isOrgSlug, isUuid, MOVE_BEYOND_SLUG, ROLE_LABELS, type OrgRole } from "@/lib/orgs/roles";
import { cleanPlan, cleanText, ORG_LIMITS, slugFromName } from "@/lib/orgs/profile";
import type { FormState } from "@/components/StateForm";

const PATH = "/admin/platform/organizations";

interface OrgLite {
  id: string;
  slug: string;
  name: string;
  status: string;
  application: Record<string, unknown> | null;
  pending_name?: string | null;
}

async function orgById(id: string): Promise<OrgLite | null> {
  if (!isUuid(id)) return null;
  const { data } = await db().from("organizations").select("id, slug, name, status, application, pending_name").eq("id", id).maybeSingle();
  return (data as OrgLite | null) ?? null;
}

/** Invites someone into an organisation on Move Beyond's behalf; the link comes back once in the message. */
async function inviteInto(staff: StaffPrincipal, org: OrgLite, email: string, role: OrgRole): Promise<string> {
  const r = await createInvite({ organizationId: org.id, email, role, createdBy: staff.userId, createdByRole: "platform" });
  if (!r.ok) return `Invite not created: ${r.message}`;
  const sent = await sendInviteEmail({ inviteId: r.id, email: r.email, orgName: org.name, role, inviter: "Move Beyond", link: r.link, token: r.token });
  await audit({ organization_id: org.id, actor_role: "platform", action: "INVITE_CREATED", entity_type: "organization_invite", entity_id: r.id, new_value: { role, emailed: sent.ok, by: "platform" } });
  return `${sent.ok ? `Invite emailed to ${r.email}` : `Could not email ${r.email}; send the link yourself`} as ${ROLE_LABELS[role].toLowerCase()}. Link (shown once, works once, 7 days): ${r.link}`;
}

function inviteTarget(formData: FormData, fallbackEmail: unknown): { email: string; role: OrgRole } | { error: string } | null {
  const email = normalizeEmail(String(formData.get("invite_email") ?? "") || (typeof fallbackEmail === "string" ? fallbackEmail : ""));
  if (!email) return null;
  if (!isValidEmail(email)) return { error: "Enter a valid email address for the invite." };
  const role = String(formData.get("invite_role") ?? "owner");
  if (!isOrgRole(role)) return { error: "Pick a role for the invite." };
  return { email, role };
}

/** Approves an application (and invites its applicant, or another address, as owner) or rejects it. */
export async function decideApplication(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requirePlatformPermission();
  const org = await orgById(String(formData.get("org_id") ?? ""));
  if (!org) return { ok: false, message: "Not found" };
  if (org.status !== "applied") return { ok: false, message: `This organisation is ${org.status}, not waiting for a decision.` };
  const decision = String(formData.get("decision") ?? "");
  if (decision === "reject") {
    await db().from("organizations").update({ status: "rejected", updated_at: new Date().toISOString() }).eq("id", org.id).eq("status", "applied");
    await audit({ organization_id: org.id, actor_role: "platform", action: "ORGANIZATION_REJECTED", entity_type: "organization", entity_id: org.id });
    revalidatePath(PATH);
    return { ok: true, message: `${org.name}: application turned down.` };
  }
  if (decision !== "approve") return { ok: false, message: "Approve or reject." };
  const target = inviteTarget(formData, org.application?.contact_email);
  if (target && "error" in target) return { ok: false, message: target.error };
  // Its name is checked again now (another organisation may have taken it since), and
  // only now does it get its public slug: applications hold a placeholder.
  const nameRefused = await orgNameRefusal(org.name, { id: org.id });
  if (nameRefused) return { ok: false, message: `${org.name}: ${nameRefused}` };
  const typedSlug = String(formData.get("slug") ?? "").trim().toLowerCase();
  if (typedSlug && !isOrgSlug(typedSlug)) return { ok: false, message: "The short name may use a–z, 0–9 and hyphens (2–60)." };
  const base = typedSlug || slugFromName(org.name);
  let approved = false;
  let slug = base;
  for (let attempt = 0; attempt < 4 && !approved; attempt++) {
    slug = attempt === 0 ? base : `${base.slice(0, 50)}-${randomBytes(3).toString("hex")}`;
    const { data: changed, error } = await db()
      .from("organizations")
      .update({ status: "approved", slug, updated_at: new Date().toISOString() })
      .eq("id", org.id)
      .eq("status", "applied")
      .select("id");
    if (changed?.length) approved = true;
    else if (!/duplicate|unique/i.test(error?.message ?? "")) return { ok: false, message: "Already decided." };
    else if (typedSlug) return { ok: false, message: `The short name "${typedSlug}" is taken: type another.` };
  }
  if (!approved) return { ok: false, message: "Could not find a free short name. Type one." };
  org.slug = slug;
  await audit({ organization_id: org.id, actor_role: "platform", action: "ORGANIZATION_APPROVED", entity_type: "organization", entity_id: org.id });
  const note = target ? await inviteInto(staff, { ...org, status: "approved" }, target.email, target.role) : "No invite sent.";
  revalidatePath(PATH);
  return { ok: true, message: `${org.name} approved. ${note}` };
}

/** Suspends an approved organisation (every member and code stops on the next request) or reinstates it. */
export async function setOrganizationStatus(_prev: FormState, formData: FormData): Promise<FormState> {
  await requirePlatformPermission();
  const org = await orgById(String(formData.get("org_id") ?? ""));
  if (!org) return { ok: false, message: "Not found" };
  const to = String(formData.get("status") ?? "");
  const from = to === "suspended" ? "approved" : to === "approved" ? "suspended" : null;
  if (!from) return { ok: false, message: "Suspend or reinstate." };
  if (org.slug === MOVE_BEYOND_SLUG && to === "suspended") return { ok: false, message: "Move Beyond itself cannot be suspended." };
  const { data: changed } = await db().from("organizations").update({ status: to, updated_at: new Date().toISOString() }).eq("id", org.id).eq("status", from).select("id");
  if (!changed?.length) return { ok: false, message: `This organisation is ${org.status}.` };
  await audit({ organization_id: org.id, actor_role: "platform", action: to === "suspended" ? "ORGANIZATION_SUSPENDED" : "ORGANIZATION_REINSTATED", entity_type: "organization", entity_id: org.id });
  revalidatePath(PATH);
  return { ok: true, message: to === "suspended" ? `${org.name} suspended: its staff and codes stop working on their next request.` : `${org.name} reinstated.` };
}

/** Move Beyond creates an organisation itself (approved at once) and invites its first owner or admin. */
export async function createOrganization(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requirePlatformPermission();
  const name = cleanText(formData.get("name"), ORG_LIMITS.name);
  if (!name || name.length < 2) return { ok: false, message: "Enter the organisation's name." };
  const nameRefused = await orgNameRefusal(name);
  if (nameRefused) return { ok: false, message: nameRefused };
  const typedSlug = String(formData.get("slug") ?? "").trim().toLowerCase();
  if (typedSlug && !isOrgSlug(typedSlug)) return { ok: false, message: "The short name may use a–z, 0–9 and hyphens (2–60)." };
  const target = inviteTarget(formData, null);
  if (!target) return { ok: false, message: "Enter the email of its first owner or admin." };
  if ("error" in target) return { ok: false, message: target.error };
  if (target.role !== "owner" && target.role !== "admin") return { ok: false, message: "The first person is an owner or an admin." };
  const slug = typedSlug || slugFromName(name);
  const { data, error } = await db()
    .from("organizations")
    .insert({
      slug,
      name,
      status: "approved",
      city: cleanText(formData.get("city"), ORG_LIMITS.city),
      country: cleanText(formData.get("country"), ORG_LIMITS.country),
      created_by: isUuid(staff.userId) ? staff.userId : null,
    })
    .select("id, slug, name, status, application")
    .single();
  if (error || !data) return { ok: false, message: /duplicate|unique/i.test(error?.message ?? "") ? `The short name "${slug}" is taken: type another.` : "Could not create it. Try again." };
  const org = data as OrgLite;
  await audit({ organization_id: org.id, actor_role: "platform", action: "ORGANIZATION_CREATED", entity_type: "organization", entity_id: org.id, new_value: { slug, by: "platform" } });
  const note = await inviteInto(staff, org, target.email, target.role);
  revalidatePath(PATH);
  return { ok: true, message: `${org.name} created (${org.slug}). ${note}` };
}

/** Another invite into an approved organisation (a new owner when the last one left, say). */
export async function inviteToOrganization(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requirePlatformPermission();
  const org = await orgById(String(formData.get("org_id") ?? ""));
  if (!org) return { ok: false, message: "Not found" };
  if (org.status !== "approved") return { ok: false, message: `This organisation is ${org.status}: approve it first.` };
  const target = inviteTarget(formData, null);
  if (!target) return { ok: false, message: "Enter an email." };
  if ("error" in target) return { ok: false, message: target.error };
  const note = await inviteInto(staff, org, target.email, target.role);
  revalidatePath(PATH);
  return { ok: true, message: note };
}

/** Billing fields (nothing is charged in this build): tier, commission %, subscription status. Platform admins only. */
export async function saveBilling(_prev: FormState, formData: FormData): Promise<FormState> {
  await requirePlatformPermission();
  const org = await orgById(String(formData.get("org_id") ?? ""));
  if (!org) return { ok: false, message: "Not found" };
  const { data: cur } = await db().from("organizations").select("plan").eq("id", org.id).maybeSingle();
  const before = cleanPlan((cur as { plan: unknown } | null)?.plan);
  const plan = cleanPlan({
    ...before,
    tier: String(formData.get("tier") ?? before.tier),
    commission_pct: String(formData.get("commission_pct") ?? before.commission_pct),
    subscription_status: String(formData.get("subscription_status") ?? before.subscription_status),
  });
  const { error } = await db().from("organizations").update({ plan, updated_at: new Date().toISOString() }).eq("id", org.id);
  if (error) return { ok: false, message: "Could not save. Try again." };
  await audit({ organization_id: org.id, actor_role: "platform", action: "ORGANIZATION_PLAN_UPDATED", entity_type: "organization", entity_id: org.id, old_value: before, new_value: plan });
  revalidatePath(PATH);
  return { ok: true, message: "Saved." };
}

/**
 * An approved organisation's new name waits for a platform admin (it shows in
 * emails and on public pages, and must not pass for Move Beyond or another
 * organisation): approve it (checked again) or turn it down.
 */
export async function decideRename(_prev: FormState, formData: FormData): Promise<FormState> {
  await requirePlatformPermission();
  const org = await orgById(String(formData.get("org_id") ?? ""));
  if (!org) return { ok: false, message: "Not found" };
  const pending = org.pending_name;
  if (!pending) return { ok: false, message: "No name change is waiting." };
  const decision = String(formData.get("decision") ?? "");
  const at = new Date().toISOString();
  if (decision === "reject") {
    await db().from("organizations").update({ pending_name: null, pending_name_at: null, updated_at: at }).eq("id", org.id).eq("pending_name", pending);
    await audit({ organization_id: org.id, actor_role: "platform", action: "ORGANIZATION_RENAME_REJECTED", entity_type: "organization", entity_id: org.id, new_value: { name: pending } });
    revalidatePath(PATH);
    return { ok: true, message: `${org.name} keeps its name.` };
  }
  if (decision !== "approve") return { ok: false, message: "Approve or turn down." };
  const refused = await orgNameRefusal(pending, { id: org.id, slug: org.slug });
  if (refused) return { ok: false, message: refused };
  const { data: changed } = await db()
    .from("organizations")
    .update({ name: pending, pending_name: null, pending_name_at: null, updated_at: at })
    .eq("id", org.id)
    .eq("pending_name", pending)
    .select("id");
  if (!changed?.length) return { ok: false, message: "The request changed meanwhile. Look again." };
  await audit({ organization_id: org.id, actor_role: "platform", action: "ORGANIZATION_RENAMED", entity_type: "organization", entity_id: org.id, old_value: { name: org.name }, new_value: { name: pending } });
  revalidatePath(PATH);
  return { ok: true, message: `Renamed to ${pending}.` };
}

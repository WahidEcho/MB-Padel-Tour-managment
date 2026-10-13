/**
 * Staff invites: our own single-use links, bound to the invited email, valid for
 * seven days, revocable until used. No Supabase admin API: the person signs in
 * (Google, or their Move Score email + password) as they would anyway, the
 * server checks that the confirmed email of that sign-in is the invited one, and
 * only then is the membership written (active, with the invited role).
 *
 * Server-only. The token never reaches the database (only its HMAC; see
 * inviteToken.ts), the audit log or message_deliveries (sendTransactional's
 * `redact`); the person who sent it sees the link once, like an event code.
 */
import { cookies, headers } from "next/headers";
import { db } from "../supabase";
import { isLocalHost } from "../auth";
import { audit } from "../audit";
import { isValidEmail, normalizeEmail } from "../auth/password";
import { sendTransactional } from "../messaging/queue";
import { siteUrl } from "../messaging/links";
import { isOrgRole, isUuid, ROLE_LABELS, type OrgRole } from "./roles";
import { INVITE_TTL_MS, generateInviteToken, hashInviteToken, isInviteTokenShaped } from "./inviteToken";

export interface InviteRow {
  id: string;
  organization_id: string;
  email: string;
  role: OrgRole;
  expires_at: string;
  accepted_at: string | null;
  accepted_by: string | null;
  revoked_at: string | null;
  created_at: string;
}

export const INVITE_COLUMNS = "id, organization_id, email, role, expires_at, accepted_at, accepted_by, revoked_at, created_at";

export type InviteState = "pending" | "accepted" | "revoked" | "expired";

export function inviteState(i: Pick<InviteRow, "accepted_at" | "revoked_at" | "expires_at">, now = Date.now()): InviteState {
  if (i.accepted_at) return "accepted";
  if (i.revoked_at) return "revoked";
  return Date.parse(i.expires_at) <= now ? "expired" : "pending";
}

export function inviteLink(token: string): string {
  return `${siteUrl()}/invite/open?t=${token}`;
}

/* ---------------- creating ---------------- */

export type CreateInvite =
  | { ok: true; id: string; link: string; token: string; email: string }
  | { ok: false; message: string };

/**
 * A new invite. Any earlier invite of the same organisation to the same address
 * that is still open is revoked, so only the newest link works.
 */
export async function createInvite(input: {
  organizationId: string;
  email: string;
  role: OrgRole;
  createdBy: string | null;
  createdByRole: string;
}): Promise<CreateInvite> {
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) return { ok: false, message: "Enter a valid email address." };
  if (!isOrgRole(input.role)) return { ok: false, message: "Pick a role." };
  const token = generateInviteToken();
  let tokenHash: string;
  try {
    tokenHash = hashInviteToken(token);
  } catch (err) {
    console.error("invites unavailable:", (err as Error).message);
    return { ok: false, message: "Invites are not set up on this server yet (EVENT_CODE_PEPPER). Contact Move Beyond." };
  }
  const now = new Date();
  await db()
    .from("organization_invites")
    .update({ revoked_at: now.toISOString() })
    .eq("organization_id", input.organizationId)
    .eq("email", email)
    .is("accepted_at", null)
    .is("revoked_at", null);
  const { data, error } = await db()
    .from("organization_invites")
    .insert({
      organization_id: input.organizationId,
      email,
      role: input.role,
      token_hash: tokenHash,
      expires_at: new Date(now.getTime() + INVITE_TTL_MS).toISOString(),
      created_by: isUuid(input.createdBy) ? input.createdBy : null,
      created_by_role: input.createdByRole,
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, message: "Could not create the invite. Try again." };
  return { ok: true, id: (data as { id: string }).id, link: inviteLink(token), token, email };
}

/** Emails the invite with the branded layout. The link is redacted from what is stored. */
export async function sendInviteEmail(input: { inviteId: string; email: string; orgName: string; role: OrgRole; inviter: string; link: string; token: string }) {
  return sendTransactional({
    to: input.email,
    channel: "email",
    template: "staff_invite",
    vars: {
      organization: input.orgName,
      role: ROLE_LABELS[input.role].toLowerCase(),
      inviter: input.inviter,
      email: input.email,
      link: input.link,
      title: `Join ${input.orgName} on Move Score`,
    },
    recipient: { kind: "adhoc", name: null },
    redact: [input.link, input.token],
  });
}

/* ---------------- the person who opens the link ---------------- */

export interface InviteView {
  invite: InviteRow;
  state: InviteState;
  org: { id: string; name: string; slug: string; status: string };
}

/** The invite a token belongs to (and its organisation); null for anything that is not one. */
export async function inviteByToken(token: string | null | undefined): Promise<InviteView | null> {
  if (!isInviteTokenShaped(token)) return null;
  let tokenHash: string;
  try {
    tokenHash = hashInviteToken(token);
  } catch {
    return null;
  }
  const { data } = await db().from("organization_invites").select(INVITE_COLUMNS).eq("token_hash", tokenHash).maybeSingle();
  const invite = data as InviteRow | null;
  if (!invite) return null;
  const { data: o } = await db().from("organizations").select("id, name, slug, status").eq("id", invite.organization_id).maybeSingle();
  if (!o) return null;
  return { invite, state: inviteState(invite), org: o as InviteView["org"] };
}

export type AcceptRefusal = "invalid" | "used" | "revoked" | "expired" | "wrong_email" | "org_unavailable";

export const ACCEPT_MESSAGES: Record<AcceptRefusal, string> = {
  invalid: "This invite link is not valid. Ask for a new one.",
  used: "This invite has already been used. Sign in at the staff login.",
  revoked: "This invite was withdrawn. Ask for a new one.",
  expired: "This invite has expired (links last 7 days). Ask for a new one.",
  wrong_email: "This invite is for a different email address. Sign in with the address it was sent to.",
  org_unavailable: "This organisation is not open on Move Score right now. Contact Move Beyond.",
};

/**
 * Accepts an invite for a person the server has just signed in itself
 * (getAuthUser): their confirmed email must be the invited one. Single use: the
 * row is claimed with a conditional update before the membership is written.
 */
export async function acceptInvite(
  token: string | null | undefined,
  user: { id: string; email?: string | null; email_confirmed_at?: string | null; is_anonymous?: boolean },
  now = Date.now(),
): Promise<{ ok: true; orgId: string; role: OrgRole } | { ok: false; reason: AcceptRefusal }> {
  const view = await inviteByToken(token);
  if (!view) return { ok: false, reason: "invalid" };
  const { invite, org } = view;
  const state = inviteState(invite, now);
  if (state === "accepted") return { ok: false, reason: "used" };
  if (state !== "pending") return { ok: false, reason: state };
  if (org.status !== "approved") return { ok: false, reason: "org_unavailable" };
  const email = user.email ? normalizeEmail(user.email) : "";
  if (!isUuid(user.id) || user.is_anonymous || !user.email_confirmed_at || email !== invite.email) return { ok: false, reason: "wrong_email" };

  // Claim it: only one request can turn accepted_at from null.
  const at = new Date(now).toISOString();
  const { data: claimed } = await db()
    .from("organization_invites")
    .update({ accepted_at: at, accepted_by: user.id })
    .eq("id", invite.id)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .gt("expires_at", at)
    .select("id");
  if (!claimed?.length) return { ok: false, reason: "used" };

  const { data: existing } = await db()
    .from("organization_members")
    .select("id, role, status")
    .eq("organization_id", invite.organization_id)
    .eq("auth_user_id", user.id)
    .maybeSingle();
  const prior = existing as { id: string; role: OrgRole; status: string } | null;
  let role = invite.role;
  if (prior) {
    // An active owner stays owner (an invite never demotes); anyone else takes the invited role.
    if (prior.status === "active" && prior.role === "owner") role = "owner";
    await db().from("organization_members").update({ role, status: "active", invited_email: invite.email, updated_at: at }).eq("id", prior.id);
  } else {
    await db()
      .from("organization_members")
      .insert({ organization_id: invite.organization_id, auth_user_id: user.id, invited_email: invite.email, role, status: "active", invited_by: null });
  }
  await audit({
    organization_id: invite.organization_id,
    actor_role: "user",
    action: "INVITE_ACCEPTED",
    entity_type: "organization_invite",
    entity_id: invite.id,
    new_value: { role },
  });
  return { ok: true, orgId: invite.organization_id, role };
}

/* ---------------- the browser's pending invite ---------------- */

const COOKIE = "mb_invite";
const HOST_COOKIE = "__Host-mb_invite";

/**
 * The token from a link is moved straight into this httpOnly cookie (and the
 * address bar cleaned), so it is in no further URL, page or referrer; the
 * sign-in that follows reads it from here. An hour is enough to sign in.
 */
export async function setInviteCookie(token: string) {
  const local = isLocalHost((await headers()).get("host"));
  (await cookies()).set(local ? COOKIE : HOST_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: !local, path: "/", maxAge: 3600 });
}

export async function readInviteCookie(): Promise<string | null> {
  const local = isLocalHost((await headers()).get("host"));
  const store = await cookies();
  const v = store.get(HOST_COOKIE)?.value ?? (local ? store.get(COOKIE)?.value : undefined);
  return isInviteTokenShaped(v) ? v : null;
}

export async function clearInviteCookie() {
  const store = await cookies();
  store.set(HOST_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 0 });
  store.set(COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
}

/**
 * The step every staff sign-in takes once the server has checked the person's
 * Supabase session: when this browser carries an invite, accept it for them.
 * `null` when there was none; the cookie is kept only after a wrong-email
 * attempt (the person can try again with the right account).
 */
export async function acceptPendingInvite(user: Parameters<typeof acceptInvite>[1]): Promise<Awaited<ReturnType<typeof acceptInvite>> | null> {
  const token = await readInviteCookie();
  if (!token) return null;
  const r = await acceptInvite(token, user);
  if (r.ok || r.reason !== "wrong_email") await clearInviteCookie();
  return r;
}

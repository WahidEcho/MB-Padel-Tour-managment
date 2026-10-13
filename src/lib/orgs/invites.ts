/**
 * Staff invites: our own single-use links, bound to the invited email, valid for
 * seven days, revocable until used. No Supabase admin API: the person signs in
 * (Google, or their Move Score email + password) as they would anyway, the
 * server checks that the confirmed email of that sign-in is the invited one, and
 * then **asks** "Join <organisation> as <role>?" (Accept / Not now). Only Accept,
 * a same-origin POST, writes the membership. A sign-in is never blocked or
 * changed by an invite the browser happens to carry: a link someone else planted
 * (the cookie is set by a plain GET) can neither join the person to an
 * organisation unasked nor lock them out of their own.
 *
 * Server-only. The token never reaches the database (only its HMAC; see
 * inviteToken.ts), the audit log or message_deliveries (sendTransactional's
 * `redact`); the person who sent it sees the link once, like an event code.
 */
import { cookies, headers } from "next/headers";
import { db } from "../supabase";
import { isLocalHost } from "../auth";
import { audit } from "../audit";
import { isPlatformAdmin } from "../auth/staff";
import { isValidEmail, normalizeEmail } from "../auth/password";
import { sendTransactional } from "../messaging/queue";
import { siteUrl } from "../messaging/links";
import { noAutolink } from "../email/layout";
import { isOrgRole, isUuid, mayAssignRole, roleOnAccept, ROLE_LABELS, type OrgRole } from "./roles";
import { INVITE_TTL_MS, generateInviteToken, hashInviteToken, isInviteTokenShaped, openInviteConfirm, sealInviteConfirm, type InviteConfirm } from "./inviteToken";

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
  created_by: string | null;
  /** The sender's organisation role when they sent it, or "platform". */
  created_by_role: string | null;
}

export const INVITE_COLUMNS = "id, organization_id, email, role, expires_at, accepted_at, accepted_by, revoked_at, created_at, created_by, created_by_role";

export type InviteState = "pending" | "accepted" | "revoked" | "expired";

export function inviteState(i: Pick<InviteRow, "accepted_at" | "revoked_at" | "expires_at">, now = Date.now()): InviteState {
  if (i.accepted_at) return "accepted";
  if (i.revoked_at) return "revoked";
  return Date.parse(i.expires_at) <= now ? "expired" : "pending";
}

/** The link: the token rides in the fragment, which no server, proxy log or Referer ever sees. */
export function inviteLink(token: string): string {
  return `${siteUrl()}/invite/open#t=${token}`;
}

/* ---------------- creating ---------------- */

export type CreateInvite =
  | { ok: true; id: string; link: string; token: string; email: string }
  | { ok: false; message: string };

/**
 * A new invite. Earlier open invites of the same organisation to the same address
 * are withdrawn, so only the newest link works, but only those the sender could
 * have sent themselves: an admin's invite never cancels an owner's invite of an
 * admin or owner (it is refused instead, with the reason).
 */
export async function createInvite(input: {
  organizationId: string;
  email: string;
  role: OrgRole;
  createdBy: string | null;
  /** The sender's organisation role, or "platform" (Move Beyond's platform admins). */
  createdByRole: OrgRole | "platform";
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
  const { data: open } = await db()
    .from("organization_invites")
    .select("id, role")
    .eq("organization_id", input.organizationId)
    .eq("email", email)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .gt("expires_at", now.toISOString());
  const earlier = (open ?? []) as { id: string; role: OrgRole }[];
  const sender = input.createdByRole;
  if (sender !== "platform" && earlier.some((i) => !mayAssignRole(sender, null, i.role))) {
    return { ok: false, message: "An owner has already invited this address as owner or admin. Ask an owner to withdraw that invite first." };
  }
  if (earlier.length) {
    await db()
      .from("organization_invites")
      .update({ revoked_at: now.toISOString() })
      .in("id", earlier.map((i) => i.id))
      .is("accepted_at", null)
      .is("revoked_at", null);
  }
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

/**
 * Withdraws the open invites a departing member leaves behind: those they sent,
 * and any to their own address (they cannot walk back in with an older link).
 */
export async function withdrawInvitesOf(orgId: string, member: { authUserId: string | null; email: string | null }): Promise<number> {
  const at = new Date().toISOString();
  let n = 0;
  if (isUuid(member.authUserId)) {
    const { data } = await db()
      .from("organization_invites")
      .update({ revoked_at: at })
      .eq("organization_id", orgId)
      .eq("created_by", member.authUserId)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .select("id");
    n += data?.length ?? 0;
  }
  const email = member.email ? normalizeEmail(member.email) : "";
  if (email) {
    const { data } = await db()
      .from("organization_invites")
      .update({ revoked_at: at })
      .eq("organization_id", orgId)
      .eq("email", email)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .select("id");
    n += data?.length ?? 0;
  }
  return n;
}

/** Emails the invite with the branded layout. The link is redacted from what is stored. */
export async function sendInviteEmail(input: { inviteId: string; email: string; orgName: string; role: OrgRole; inviter: string; link: string; token: string }) {
  return sendTransactional({
    to: input.email,
    channel: "email",
    template: "staff_invite",
    // Names are the organisation's own text: never turned into links in the email.
    vars: {
      organization: noAutolink(input.orgName),
      role: ROLE_LABELS[input.role].toLowerCase(),
      inviter: noAutolink(input.inviter),
      email: input.email,
      link: input.link,
      title: `Join ${noAutolink(input.orgName)} on Move Score`,
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

/** Who sent the invite, as they are now: their current role, "platform", or null when they no longer may invite. */
async function inviterNow(invite: InviteRow): Promise<OrgRole | "platform" | null> {
  if (invite.created_by_role === "platform") {
    return isUuid(invite.created_by) && (await isPlatformAdmin(invite.created_by)) ? "platform" : null;
  }
  if (!isUuid(invite.created_by)) return null;
  const { data } = await db()
    .from("organization_members")
    .select("role")
    .eq("organization_id", invite.organization_id)
    .eq("auth_user_id", invite.created_by)
    .eq("status", "active")
    .maybeSingle();
  const role = (data as { role: OrgRole } | null)?.role ?? null;
  return role && isOrgRole(role) ? role : null;
}

/**
 * Accepts an invite for a person the server itself checked (a sign-in, sealed in
 * the confirm cookie): their confirmed email must be the invited one. Single use:
 * the row is claimed with a conditional update before the membership is written.
 * The sender must still be able to give the role (a removed or demoted sender's
 * invite is void), and an invite never lowers anybody's role (`roleOnAccept`).
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

  const { data: existing } = await db()
    .from("organization_members")
    .select("id, role, status")
    .eq("organization_id", invite.organization_id)
    .eq("auth_user_id", user.id)
    .maybeSingle();
  const prior = existing as { id: string; role: OrgRole; status: string } | null;
  const current = prior?.status === "active" ? prior.role : null;
  const role = roleOnAccept(invite.role, await inviterNow(invite), current);
  if (!role) return { ok: false, reason: "revoked" };

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

  if (prior) {
    await db().from("organization_members").update({ role, status: "active", invited_email: invite.email, updated_at: at }).eq("id", prior.id);
  } else {
    await db()
      .from("organization_members")
      .insert({ organization_id: invite.organization_id, auth_user_id: user.id, invited_email: invite.email, role, status: "active", invited_by: isUuid(invite.created_by) ? invite.created_by : null });
  }
  await audit({
    organization_id: invite.organization_id,
    actor_role: "user",
    // The person who accepted (checked by the server at sign-in), not any staff cookie.
    actor_user_id: user.id,
    action: "INVITE_ACCEPTED",
    entity_type: "organization_invite",
    entity_id: invite.id,
    new_value: { role, invited_role: invite.role, kept_role: prior?.status === "active" && role === prior.role && role !== invite.role },
  });
  return { ok: true, orgId: invite.organization_id, role };
}

/* ---------------- the browser's pending invite ---------------- */

const COOKIE = "mb_invite";
const HOST_COOKIE = "__Host-mb_invite";
const CONFIRM_COOKIE = "mb_invite_ok";
const HOST_CONFIRM_COOKIE = "__Host-mb_invite_ok";

async function setCookiePair(names: [string, string], value: string, maxAge: number) {
  const local = isLocalHost((await headers()).get("host"));
  (await cookies()).set(local ? names[0] : names[1], value, { httpOnly: true, sameSite: "lax", secure: !local, path: "/", maxAge });
}

async function readCookiePair(names: [string, string]): Promise<string | undefined> {
  const local = isLocalHost((await headers()).get("host"));
  const store = await cookies();
  return store.get(names[1])?.value ?? (local ? store.get(names[0])?.value : undefined);
}

/**
 * The token from a link is moved straight into this httpOnly cookie (the page at
 * /invite/open posts it from the link's fragment), so it is in no URL, page or
 * referrer; the sign-in that follows reads it from here. An hour is enough to sign in.
 */
export async function setInviteCookie(token: string) {
  await setCookiePair([COOKIE, HOST_COOKIE], token, 3600);
}

export async function readInviteCookie(): Promise<string | null> {
  const v = await readCookiePair([COOKIE, HOST_COOKIE]);
  return isInviteTokenShaped(v) ? v : null;
}

/** Forgets the invite in this browser, and any pending "Join … ?" answer. */
export async function clearInviteCookie() {
  const store = await cookies();
  for (const [plain, host] of [[COOKIE, HOST_COOKIE], [CONFIRM_COOKIE, HOST_CONFIRM_COOKIE]]) {
    store.set(host, "", { httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 0 });
    store.set(plain, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  }
}

/** The signed-in person who may answer the invite in this browser (15 minutes after their sign-in). */
export async function readInviteConfirm(): Promise<InviteConfirm | null> {
  return openInviteConfirm(await readCookiePair([CONFIRM_COOKIE, HOST_CONFIRM_COOKIE]));
}

export type PendingInvite = { ok: true; view: InviteView } | { ok: false; reason: AcceptRefusal };

/**
 * The step every staff sign-in takes once the server has checked the person's
 * Supabase session. It never accepts anything and never blocks the sign-in:
 * - an invite this person can answer (pending, approved organisation, their
 *   confirmed email): remembered as theirs for 15 minutes (`ok`), and the sign-in
 *   then shows "Join <organisation> as <role>?" at /invite;
 * - anything else (another address, used, withdrawn, expired, forged): the
 *   browser forgets it at once (`ok: false` with the reason, shown only when the
 *   sign-in has nowhere else to go).
 * `null` when the browser carries no invite.
 */
export async function pendingInviteFor(user: { id: string; email?: string | null; email_confirmed_at?: string | null; is_anonymous?: boolean }): Promise<PendingInvite | null> {
  const token = await readInviteCookie();
  if (!token) return null;
  const view = await inviteByToken(token);
  let reason: AcceptRefusal | null = null;
  if (!view) reason = "invalid";
  else if (view.state === "accepted") reason = "used";
  else if (view.state !== "pending") reason = view.state;
  else if (view.org.status !== "approved") reason = "org_unavailable";
  else {
    const email = user.email ? normalizeEmail(user.email) : "";
    if (!isUuid(user.id) || user.is_anonymous || !user.email_confirmed_at || email !== view.invite.email) reason = "wrong_email";
  }
  if (reason || !view) {
    await clearInviteCookie();
    return { ok: false, reason: reason ?? "invalid" };
  }
  await setCookiePair([CONFIRM_COOKIE, HOST_CONFIRM_COOKIE], sealInviteConfirm({ userId: user.id, email: view.invite.email, inviteId: view.invite.id }), 15 * 60);
  return { ok: true, view };
}

/**
 * "Accept" on the "Join … ?" question: the invite in this browser's cookie, for
 * the person sealed in the confirm cookie at their sign-in, and nobody else.
 */
export async function acceptPendingInvite(): Promise<Awaited<ReturnType<typeof acceptInvite>> & { userId?: string }> {
  const [token, confirm] = await Promise.all([readInviteCookie(), readInviteConfirm()]);
  if (!token || !confirm) return { ok: false, reason: "invalid" };
  const view = await inviteByToken(token);
  if (!view || view.invite.id !== confirm.inviteId) {
    await clearInviteCookie();
    return { ok: false, reason: "invalid" };
  }
  const r = await acceptInvite(token, { id: confirm.userId, email: confirm.email, email_confirmed_at: "checked at sign-in", is_anonymous: false });
  await clearInviteCookie();
  return r.ok ? { ...r, userId: confirm.userId } : r;
}

/** A form POST from this site's own pages (route handlers get no CSRF check of their own). */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

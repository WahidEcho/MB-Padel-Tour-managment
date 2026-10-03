/**
 * Move Score accounts on the server, whatever the way in: Apple, Google, email +
 * password, or a player code (a Supabase anonymous user until the player adds and
 * confirms an email).
 *
 * Everything here works with the anon (publishable) key that production still
 * uses: no auth.admin call is needed to sign up, sign in, confirm, recover, or to
 * turn an anonymous player into a registered account. Calls that act as one
 * person go to Supabase Auth's REST API with that person's access token.
 */
import type { Session, User } from "@supabase/supabase-js";
import { db } from "@/lib/supabase";
import { openToken, sealToken } from "./users";

export type AppProvider = "apple" | "google" | "email" | "player_code";

/* ---------------- links in the emails ---------------- */

const DEFAULT_SITE = "https://mb-tournament.vercel.app";

/** Where the confirmation and password emails send people (PUBLIC_SITE_URL in other environments). */
export function authSiteUrl(): string {
  return (process.env.PUBLIC_SITE_URL || DEFAULT_SITE).replace(/\/+$/, "");
}
export const confirmUrl = () => `${authSiteUrl()}/movescore/auth/confirm`;
export const resetUrl = () => `${authSiteUrl()}/movescore/auth/reset`;
/** Where the confirm page sends the phone back to. */
export const APP_CONFIRMED_LINK = "movescore://auth/confirmed";

/* ---------------- Supabase Auth's REST API, as one person ---------------- */

export interface AuthUser {
  id: string;
  email?: string | null;
  new_email?: string | null;
  email_confirmed_at?: string | null;
  is_anonymous?: boolean;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
}

type AuthResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string | null; message: string };

async function asUser<T>(method: string, path: string, accessToken: string, body?: unknown): Promise<AuthResult<T>> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_KEY must be set");
  try {
    const res = await fetch(`${url}/auth/v1${path}`, {
      method,
      headers: { apikey: key, Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      const code = (typeof json.error_code === "string" ? json.error_code : typeof json.code === "string" ? json.code : null) as string | null;
      const message = String(json.msg ?? json.message ?? json.error_description ?? json.error ?? `Auth error ${res.status}`);
      return { ok: false, status: res.status, code, message };
    }
    return { ok: true, data: json as T };
  } catch (e) {
    return { ok: false, status: 0, code: null, message: e instanceof Error ? e.message : "Auth unreachable" };
  }
}

/** The person behind an access token, straight from Supabase Auth (authoritative, unlike the token's claims). */
export const getAuthUser = (accessToken: string) => asUser<AuthUser>("GET", "/user", accessToken);

/** Changes the person's own email and/or password. A new email is confirmed by the link Supabase sends. */
export function updateAuthUser(accessToken: string, attrs: { email?: string; password?: string; data?: Record<string, unknown> }, emailRedirectTo?: string) {
  const q = emailRedirectTo ? `?redirect_to=${encodeURIComponent(emailRedirectTo)}` : "";
  return asUser<AuthUser>("PUT", `/user${q}`, accessToken, attrs);
}

/** Ends the person's sessions: "global" signs out every phone (used on account deletion). */
export async function signOutAuth(accessToken: string, scope: "global" | "local" = "local"): Promise<boolean> {
  const r = await asUser<unknown>("POST", `/logout?scope=${scope}`, accessToken);
  return r.ok;
}

/**
 * Trades a refresh token for a new session, once, with no retries (supabase-js
 * retries 5xx answers for up to 30 seconds, longer than the phone waits). The
 * caller decides from status and code whether the session is over
 * (sessionRules.refreshVerdict).
 */
export async function refreshAuthSession(
  refreshToken: string,
): Promise<{ ok: true; accessToken: string; refreshToken: string; expiresAt: number | null } | { ok: false; status: number; code: string | null; message: string }> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_KEY must be set");
  try {
    const res = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok && typeof json.access_token === "string" && typeof json.refresh_token === "string") {
      const expiresAt = typeof json.expires_at === "number" ? json.expires_at : typeof json.expires_in === "number" ? Math.floor(Date.now() / 1000) + json.expires_in : null;
      return { ok: true, accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt };
    }
    const code = typeof json.error_code === "string" ? json.error_code : typeof json.code === "string" ? json.code : null;
    return { ok: false, status: res.status, code, message: String(json.msg ?? json.message ?? json.error_description ?? json.error ?? "") };
  } catch (e) {
    return { ok: false, status: 0, code: null, message: e instanceof Error ? e.message : "unreachable" };
  }
}

/* ---------------- finishing a sign-in ---------------- */

export interface SessionReply {
  userId: string;
  displayName: string | null;
  email: string | null;
  avatarUrl: string | null;
  provider: AppProvider;
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
  registrationComplete: boolean;
}

/**
 * The same last step for every way in: the account row is written (or brought up
 * to date), a deletion still waiting for staff is cancelled (the person came back,
 * so they start a fresh account), and the app gets its session. The app then
 * links its phone and syncs follows (move-score-app/src/auth/signIn.ts finish()).
 */
export async function finishSignIn(opts: {
  session: Session;
  user: User;
  provider: AppProvider;
  displayName?: string | null;
  registrationComplete?: boolean;
  extraRow?: Record<string, unknown>;
}): Promise<SessionReply> {
  const { session, user, provider } = opts;
  const meta = (user.user_metadata ?? {}) as { full_name?: string; name?: string; avatar_url?: string; picture?: string };
  const displayName = (opts.displayName || meta.full_name || meta.name || "").trim().slice(0, 60) || null;
  const avatar = meta.avatar_url || meta.picture || null;
  const avatarUrl = typeof avatar === "string" && /^https:\/\//.test(avatar) ? avatar : null;
  const registrationComplete = opts.registrationComplete ?? true;
  const row: Record<string, unknown> = {
    auth_user_id: user.id,
    provider,
    registration_complete: registrationComplete,
    updated_at: new Date().toISOString(),
    ...(opts.extraRow ?? {}),
  };
  if (registrationComplete) Object.assign(row, { pending_email: null, pending_password_enc: null, pending_since: null });
  if (displayName) row.display_name = displayName;
  await db().from("app_users").upsert(row, { onConflict: "auth_user_id" });
  await db().from("app_user_deletions").delete().eq("auth_user_id", user.id);
  return {
    userId: user.id,
    displayName,
    email: user.email || null,
    avatarUrl,
    provider,
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: session.expires_at ?? null,
    registrationComplete,
  };
}

/* ---------------- player-code accounts: completing the registration ---------------- */

interface AccountRow {
  provider: AppProvider | null;
  display_name: string | null;
  registration_complete: boolean | null;
  pending_email: string | null;
  pending_password_enc: string | null;
}

export async function accountRow(userId: string): Promise<AccountRow | null> {
  const { data } = await db()
    .from("app_users")
    .select("provider, display_name, registration_complete, pending_email, pending_password_enc")
    .eq("auth_user_id", userId)
    .maybeSingle();
  return (data as AccountRow | null) ?? null;
}

/** Keeps the password a player chose until their email is confirmed (sealed, never in plain text). */
export async function holdPendingRegistration(userId: string, email: string, password: string) {
  await db()
    .from("app_users")
    .update({ pending_email: email, pending_password_enc: sealToken(password), pending_since: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("auth_user_id", userId);
}

/**
 * Called once Supabase says the account is no longer anonymous (its email is
 * confirmed): sets the password the player chose, with a session of theirs, and
 * marks the account registered. Safe to call more than once. Returns false when
 * a password was waiting but could not be set yet (it stays sealed for next time).
 */
export async function completeRegistration(userId: string, accessToken: string): Promise<boolean> {
  const row = await accountRow(userId);
  if (!row) return true;
  if (row.pending_password_enc) {
    const password = openToken(row.pending_password_enc);
    if (password) {
      const set = await updateAuthUser(accessToken, { password });
      // 422 "same password" means it is already set; anything else is retried later.
      if (!set.ok && !(set.status === 422 && set.code === "same_password")) return false;
    }
  }
  await db()
    .from("app_users")
    .update({
      provider: row.provider === "player_code" ? "email" : row.provider,
      registration_complete: true,
      pending_email: null,
      pending_password_enc: null,
      pending_since: null,
      updated_at: new Date().toISOString(),
    })
    .eq("auth_user_id", userId);
  return true;
}

export interface AccountStatus {
  registrationComplete: boolean;
  email: string | null;
  pendingEmail: string | null;
  provider: AppProvider | null;
  displayName: string | null;
}

/**
 * Where the account stands, for GET /me. Asks Supabase Auth (the token's claims
 * can be an hour old); if it cannot be reached, our own row answers. Finishes a
 * player's registration the first time it sees their email confirmed.
 */
export async function accountStatus(userId: string, accessToken: string): Promise<AccountStatus> {
  const [row, live] = await Promise.all([accountRow(userId), getAuthUser(accessToken)]);
  let complete = row?.registration_complete !== false;
  if (live.ok) {
    const anonymous = live.data.is_anonymous === true;
    if (!anonymous && !complete) complete = await completeRegistration(userId, accessToken);
    if (anonymous) complete = false;
  }
  const after = complete && row?.provider === "player_code" ? "email" : (row?.provider ?? null);
  return {
    registrationComplete: complete,
    email: live.ok ? (live.data.email || null) : null,
    pendingEmail: complete ? null : (live.ok ? live.data.new_email || null : null) || row?.pending_email || null,
    provider: after,
    displayName: row?.display_name ?? null,
  };
}

/** The bearer token a request carries, or null. */
export function bearerOf(request: Request): string | null {
  const auth = request.headers.get("authorization");
  return auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() || null : null;
}

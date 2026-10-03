/**
 * Email accounts and player-code sign-in, through the Move Score server
 * (api/mobile/v1/auth/*). Passwords go to the server over HTTPS and nowhere
 * else; nothing about them is kept on the phone.
 *
 * - Sign up: email + password (rules in @core passwordChecks) → "Check your inbox".
 *   The link in the email confirms it on the web (or the six-digit code is typed here).
 * - Sign in: email + password → the same session as Apple and Google.
 * - Player code: the code the tournament sent signs the player in at once; the app
 *   then asks them to complete their registration by adding an email.
 */
import type { MMyPlayer } from "@core";
import { api, ApiError } from "../api/client";
import { patchUser, session } from "../state/session";
import { remember } from "../player/me";
import { finish, type SessionReply } from "./signIn";

export interface ConfirmSent {
  status: "confirm";
  email: string;
  message: string;
}

/** True when sign-in was refused because the email is not confirmed yet. */
export const needsConfirmation = (e: unknown) => e instanceof ApiError && (e.body as { code?: string } | null)?.code === "email_not_confirmed";

export async function signUpWithEmail(email: string, password: string, name?: string): Promise<ConfirmSent | { status: "signed_in" }> {
  const r = await api<ConfirmSent | (SessionReply & { status: "signed_in" })>("/api/mobile/v1/auth/email/signup", { body: { email, password, name: name || undefined } });
  if (r.status === "signed_in") {
    await finish(r);
    return { status: "signed_in" };
  }
  return r;
}

export async function signInWithEmail(email: string, password: string) {
  await finish(await api<SessionReply>("/api/mobile/v1/auth/email/signin", { body: { email, password } }));
}

export async function resendConfirmation(email: string): Promise<string> {
  return (await api<{ message: string }>("/api/mobile/v1/auth/email/resend", { body: { email } })).message;
}

export async function forgotPassword(email: string): Promise<string> {
  return (await api<{ message: string }>("/api/mobile/v1/auth/email/forgot", { body: { email } })).message;
}

/**
 * The six-digit code from the email, instead of its link. "signup" signs the new
 * account in; "complete" finishes a player's registration (same account, new session).
 */
export async function verifyEmailCode(email: string, code: string, purpose: "signup" | "complete") {
  const r = await api<SessionReply>("/api/mobile/v1/auth/email/verify", { body: { email, code, purpose } });
  const before = session.get().user;
  await finish(r);
  if (purpose === "complete" && before && before.id === r.userId) await patchUser(r.userId, { name: before.name ?? r.displayName });
}

/** Signs a player in with their code; the session is a player-code account until they register. */
export async function signInWithPlayerCode(code: string): Promise<{ player: MMyPlayer; linked: number }> {
  const r = await api<SessionReply & { player: MMyPlayer; linked: number }>("/api/mobile/v1/auth/player-code", { body: { code }, who: "me" });
  await finish({ ...r, provider: "player_code", registrationComplete: false });
  remember(r.userId, r.player);
  return { player: r.player, linked: r.linked };
}

/** "Complete your registration": adds the email (and the password to set once it is confirmed). */
export async function completeRegistration(email: string, password: string): Promise<ConfirmSent> {
  const r = await api<ConfirmSent>("/api/mobile/v1/auth/complete", { body: { email, password }, who: "me" });
  const u = session.get().user;
  if (u) await patchUser(u.id, { pendingEmail: r.email });
  return r;
}

interface MeReply {
  user: { id: string; displayName: string | null; email: string | null; pendingEmail: string | null; provider: SessionReply["provider"] | null; registrationComplete: boolean };
}

/** Where the account stands on the server (registration, email); kept on the phone. */
export async function refreshAccount() {
  const u = session.get().user;
  if (!u) return;
  const r = await api<MeReply>("/api/mobile/v1/me", { who: "me" });
  if (r.user.id !== u.id) return;
  await patchUser(u.id, {
    registrationComplete: r.user.registrationComplete,
    pendingEmail: r.user.pendingEmail,
    email: r.user.email ?? u.email ?? null,
    provider: r.user.provider ?? u.provider ?? null,
  });
}

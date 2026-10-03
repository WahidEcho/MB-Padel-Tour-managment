/**
 * What the links in the Move Score auth emails do on the web pages
 * /movescore/auth/confirm and /movescore/auth/reset.
 *
 * The Supabase templates (supabase/email-templates/, docs/email.md) link to
 * `<page>?token_hash=…&type=…`; the token is checked here, on the server, with
 * verifyOtp, so confirming works from any browser, with or without the app.
 * Older links that went through Supabase's own /verify first arrive with the
 * session in the URL fragment instead; the pages pass its access token here.
 */
import type { EmailOtpType } from "@supabase/supabase-js";
import { authClient } from "./users";
import { completeRegistration, getAuthUser, signOutAuth, updateAuthUser } from "./accounts";
import { passwordProblem, PASSWORD_MAX_BYTES } from "./password";

export const CONFIRM_TYPES = ["email", "signup", "magiclink", "email_change", "invite"] as const;
export type ConfirmType = (typeof CONFIRM_TYPES)[number];
export const isConfirmType = (t: unknown): t is ConfirmType => typeof t === "string" && (CONFIRM_TYPES as readonly string[]).includes(t);

const isTokenHash = (t: unknown): t is string => typeof t === "string" && /^[A-Za-z0-9_-]{8,200}$/.test(t);

export type ConfirmOutcome =
  | { ok: true; type: ConfirmType; email: string | null; registered: boolean }
  | { ok: false; reason: "invalid" | "expired" | "unavailable" };

/** Confirms the email a link was sent to. A player's registration is finished here (their password set). */
export async function confirmFromLink(tokenHash: unknown, type: unknown): Promise<ConfirmOutcome> {
  if (!isTokenHash(tokenHash) || !isConfirmType(type)) return { ok: false, reason: "invalid" };
  let res;
  try {
    res = await authClient().auth.verifyOtp({ token_hash: tokenHash, type: type as EmailOtpType });
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  const { data, error } = res;
  if (error || !data.user) {
    const temporary = !!error && (error.name === "AuthRetryableFetchError" || !error.status || error.status >= 500);
    return { ok: false, reason: temporary ? "unavailable" : "expired" };
  }
  let registered = true;
  if (data.session) {
    if (data.user.is_anonymous !== true) registered = await completeRegistration(data.user.id, data.session.access_token);
    // The page needs no session of its own: end the one verifying made.
    await signOutAuth(data.session.access_token, "local");
  }
  return { ok: true, type, email: data.user.email ?? null, registered };
}

/** For a link that already went through Supabase's /verify: finishes a player's registration with the session it carried. */
export async function finishFromAccessToken(accessToken: unknown): Promise<boolean> {
  if (typeof accessToken !== "string" || accessToken.split(".").length !== 3 || accessToken.length > 4000) return false;
  const me = await getAuthUser(accessToken);
  if (!me.ok || me.data.is_anonymous === true) return false;
  const done = await completeRegistration(me.data.id, accessToken);
  await signOutAuth(accessToken, "local");
  return done;
}

export type ResetState =
  | null
  | { ok: true; message: string }
  | { ok: false; error: string; accessToken?: string; expired?: boolean };

/**
 * Sets a new password from a recovery link. The token is spent only once the new
 * password passes the rules; if it then turns out to be the email address, the
 * session the token made is handed back so the person can try again.
 */
export async function resetWithLink(input: { tokenHash?: string | null; type?: string | null; accessToken?: string | null; password: string; confirm: string }): Promise<ResetState> {
  const { password, confirm } = input;
  if (password.length > PASSWORD_MAX_BYTES * 4) return { ok: false, error: "That password is too long.", accessToken: input.accessToken ?? undefined };
  const early = passwordProblem(password);
  if (early) return { ok: false, error: early, accessToken: input.accessToken ?? undefined };
  if (password !== confirm) return { ok: false, error: "The two passwords don't match.", accessToken: input.accessToken ?? undefined };

  let accessToken = input.accessToken ?? null;
  if (!accessToken) {
    if (!isTokenHash(input.tokenHash) || input.type !== "recovery") return { ok: false, error: "This link is incomplete. Open the newest email we sent, or ask for a new link in the app.", expired: true };
    try {
      const { data, error } = await authClient().auth.verifyOtp({ token_hash: input.tokenHash, type: "recovery" });
      if (error || !data.session) {
        const temporary = !!error && (error.name === "AuthRetryableFetchError" || !error.status || error.status >= 500);
        return temporary
          ? { ok: false, error: "Can't reach sign-in right now. Try again in a moment." }
          : { ok: false, error: "This link has expired or was already used. In Move Score, tap “Forgot password?” to get a new one.", expired: true };
      }
      accessToken = data.session.access_token;
    } catch {
      return { ok: false, error: "Can't reach sign-in right now. Try again in a moment." };
    }
  }
  const me = await getAuthUser(accessToken);
  if (!me.ok) return { ok: false, error: "This link has expired. In Move Score, tap “Forgot password?” to get a new one.", expired: true };
  const withEmail = passwordProblem(password, me.data.email);
  if (withEmail) return { ok: false, error: withEmail, accessToken };
  const set = await updateAuthUser(accessToken, { password });
  if (!set.ok) {
    if (set.code === "same_password") return { ok: false, error: "That's your current password. Choose a new one, or just sign in with it.", accessToken };
    if (set.code === "weak_password") return { ok: false, error: "Choose a stronger password.", accessToken };
    return { ok: false, error: "Couldn't change the password just now. Try again.", accessToken };
  }
  await signOutAuth(accessToken, "local");
  return { ok: true, message: "Your password is changed. Go back to Move Score and sign in with your new password." };
}

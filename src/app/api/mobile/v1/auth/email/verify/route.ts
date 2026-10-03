import { authClient } from "@/lib/auth/users";
import { completeRegistration, finishSignIn } from "@/lib/auth/accounts";
import { authJson, authUnavailable, emailAllowed, ipAllowed, isTemporary, tooMany } from "@/lib/auth/limits";
import { isValidEmail, normalizeEmail } from "@/lib/auth/password";
import { readJson } from "@/lib/mobile/http";

/**
 * POST { email, code, purpose? } → a session. The fallback to the link in the
 * email: the six-digit code it also shows, typed in the app.
 *
 * - purpose "signup" (default): confirms a new email account and signs it in.
 * - purpose "complete": a player confirming the email they added to their
 *   player-code account. The password they chose is set now and the account
 *   becomes a permanent email account (same user id, so the player link stays).
 */
export async function POST(request: Request) {
  if (!(await ipAllowed(request, "everify", 30, 600))) return tooMany();
  const body = await readJson<{ email?: unknown; code?: unknown; purpose?: unknown }>(request);
  const email = typeof body?.email === "string" ? normalizeEmail(body.email) : "";
  const code = typeof body?.code === "string" ? body.code.replace(/\D/g, "") : "";
  const complete = body?.purpose === "complete";
  if (!isValidEmail(email) || !/^\d{6}$/.test(code)) return authJson({ error: "Enter the code from the email." }, 400);
  if (!(await emailAllowed("everify", email, 8, 900))) return tooMany();

  const { data, error } = await authClient().auth.verifyOtp({ email, token: code, type: complete ? "email_change" : "email" });
  if (error || !data.session || !data.user) {
    if (error && isTemporary(error)) return error.status === 429 ? tooMany() : authUnavailable();
    return authJson({ error: "That code is wrong or has expired. Check the latest email, or send a new one." }, 400);
  }
  // If the password could not be set just now it stays sealed, and GET /me sets it next time.
  const registered = complete ? await completeRegistration(data.user.id, data.session.access_token) : true;
  return authJson(await finishSignIn({ session: data.session, user: data.user, provider: "email", registrationComplete: registered }));
}

import { authClient } from "@/lib/auth/users";
import { finishSignIn } from "@/lib/auth/accounts";
import { authJson, authUnavailable, emailAllowed, ipAllowed, isTemporary, tooMany } from "@/lib/auth/limits";
import { isValidEmail, normalizeEmail } from "@/lib/auth/password";
import { readJson } from "@/lib/mobile/http";

/**
 * POST { email, password } → the same session as Apple and Google sign-in.
 * An account whose email is not confirmed yet gets 403 { code: "email_not_confirmed" }
 * (Supabase says so only once the password is right), and the app offers to resend.
 */
export async function POST(request: Request) {
  if (!(await ipAllowed(request, "esignin", 60, 600))) return tooMany();
  const body = await readJson<{ email?: unknown; password?: unknown }>(request);
  const email = typeof body?.email === "string" ? normalizeEmail(body.email) : "";
  const password = typeof body?.password === "string" ? body.password.slice(0, 400) : "";
  if (!isValidEmail(email) || !password) return authJson({ error: "Enter your email and password." }, 400);
  if (!(await emailAllowed("esignin", email, 10, 900))) return tooMany();

  const { data, error } = await authClient().auth.signInWithPassword({ email, password });
  if (error) {
    if (error.code === "email_not_confirmed") {
      return authJson({ error: "Confirm your email first. Open the link we sent you, or send a new one.", code: "email_not_confirmed", email }, 403);
    }
    if (isTemporary(error)) return error.status === 429 ? tooMany() : authUnavailable();
    if (error.code === "email_provider_disabled") return authJson({ error: "Signing in with email isn't open yet." }, 403);
    return authJson({ error: "Email or password is incorrect.", code: "invalid_credentials" }, 401);
  }
  if (!data.session || !data.user) return authJson({ error: "Email or password is incorrect.", code: "invalid_credentials" }, 401);
  return authJson(await finishSignIn({ session: data.session, user: data.user, provider: "email" }));
}

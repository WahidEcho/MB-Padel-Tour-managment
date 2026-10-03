import { authClient } from "@/lib/auth/users";
import { confirmUrl, finishSignIn } from "@/lib/auth/accounts";
import { authJson, authUnavailable, emailAllowed, ipAllowed, isTemporary, settle, tooMany } from "@/lib/auth/limits";
import { isValidEmail, normalizeEmail, passwordProblem, PASSWORD_MAX_BYTES } from "@/lib/auth/password";
import { readJson } from "@/lib/mobile/http";

/**
 * POST { email, password, name? } → { status: "confirm", email, message }.
 *
 * Creates an email + password account; Supabase sends the confirmation email,
 * whose link opens /movescore/auth/confirm (or the person types its six-digit
 * code in the app: POST /auth/email/verify). The answer is the same whether or
 * not the address already has an account, so nobody learns who has signed up.
 * If the project confirms emails automatically, the answer is a session instead.
 */
export async function POST(request: Request) {
  const started = Date.now();
  if (!(await ipAllowed(request, "esignup", 30, 3600))) return tooMany();
  const body = await readJson<{ email?: unknown; password?: unknown; name?: unknown }>(request);
  const email = typeof body?.email === "string" ? normalizeEmail(body.email) : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 60) : "";
  if (!isValidEmail(email)) return authJson({ error: "Enter a valid email address." }, 400);
  if (password.length > PASSWORD_MAX_BYTES * 4) return authJson({ error: "That password is too long." }, 400);
  const problem = passwordProblem(password, email);
  if (problem) return authJson({ error: problem, code: "weak_password" }, 400);
  const generic = { status: "confirm", email, message: `Check your inbox to confirm ${email}.` };
  if (!(await emailAllowed("esignup", email, 5, 3600))) {
    await settle(started);
    return authJson(generic);
  }

  const { data, error } = await authClient().auth.signUp({
    email,
    password,
    options: { emailRedirectTo: confirmUrl(), ...(name ? { data: { full_name: name } } : {}) },
  });
  if (error) {
    if (isTemporary(error)) return error.status === 429 ? authJson({ error: "We've sent a lot of emails just now. Try again in a few minutes." }, 429) : authUnavailable();
    if (error.code === "weak_password") return authJson({ error: "Choose a stronger password.", code: "weak_password" }, 400);
    if (error.code === "email_address_invalid") return authJson({ error: "Enter a valid email address." }, 400);
    if (error.code === "signup_disabled" || error.code === "email_provider_disabled") return authJson({ error: "Signing up with email isn't open yet." }, 403);
    // user_already_exists and the like: the same answer as a new sign-up.
    await settle(started);
    return authJson(generic);
  }
  if (data.session && data.user) {
    return authJson({ status: "signed_in", ...(await finishSignIn({ session: data.session, user: data.user, provider: "email", displayName: name || null })) });
  }
  await settle(started);
  return authJson(generic);
}

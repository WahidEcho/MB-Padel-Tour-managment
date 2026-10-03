import { ownerOf } from "@/lib/mobile/identity";
import { readJson } from "@/lib/mobile/http";
import { audit } from "@/lib/audit";
import { bearerOf, confirmUrl, getAuthUser, holdPendingRegistration, updateAuthUser } from "@/lib/auth/accounts";
import { authJson, authUnavailable, emailAllowed, ipAllowed, tooMany } from "@/lib/auth/limits";
import { isValidEmail, normalizeEmail, passwordProblem, PASSWORD_MAX_BYTES } from "@/lib/auth/password";

/**
 * POST { email, password } with the player-code (anonymous) session →
 * { status: "confirm", email, message }.
 *
 * "Complete your registration": Supabase adds the email to the same user and
 * sends the confirmation link (and six-digit code). Supabase does not let an
 * anonymous user set a password before an email is confirmed, so the chosen
 * password is kept sealed and set the moment the email is confirmed, by the
 * confirm page, POST /auth/email/verify (the code), or GET /me — whichever comes
 * first. The user id never changes, so the player link and follows stay.
 * Calling it again sends the email again (or to a corrected address).
 */
export async function POST(request: Request) {
  const { owner } = await ownerOf(request);
  const token = bearerOf(request);
  if (owner?.kind !== "user" || !token) return authJson({ error: "Sign in with your player code first." }, 401);
  if (!(await ipAllowed(request, "ecomplete", 30, 3600))) return tooMany();
  const body = await readJson<{ email?: unknown; password?: unknown }>(request);
  const email = typeof body?.email === "string" ? normalizeEmail(body.email) : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!isValidEmail(email)) return authJson({ error: "Enter a valid email address." }, 400);
  if (password.length > PASSWORD_MAX_BYTES * 4) return authJson({ error: "That password is too long." }, 400);
  const problem = passwordProblem(password, email);
  if (problem) return authJson({ error: problem, code: "weak_password" }, 400);
  if (!(await emailAllowed("ecomplete", owner.id, 6, 3600))) return tooMany();

  const me = await getAuthUser(token);
  if (!me.ok) return me.status === 401 || me.status === 403 ? authJson({ error: "Sign in with your player code again." }, 401) : authUnavailable();
  if (me.data.is_anonymous !== true) return authJson({ error: "Your registration is already complete.", code: "already_registered" }, 409);

  const set = await updateAuthUser(token, { email }, confirmUrl());
  if (!set.ok) {
    if (set.code === "email_exists" || /already been registered|already exists/i.test(set.message)) {
      return authJson({ error: "That email already has a Move Score account. Use a different email, or sign out and sign in with that one.", code: "email_exists" }, 409);
    }
    if (set.status === 429) return authJson({ error: "We've sent a lot of emails just now. Try again in a few minutes." }, 429);
    if (set.code === "email_address_invalid") return authJson({ error: "Enter a valid email address." }, 400);
    return set.status === 0 || set.status >= 500 ? authUnavailable() : authJson({ error: "Couldn't add that email. Try again." }, 400);
  }
  await holdPendingRegistration(owner.id, email, password);
  await audit({ action: "APP_REGISTRATION_STARTED", actor_role: "user", entity_type: "user", entity_id: owner.id, new_value: {} });
  return authJson({ status: "confirm", email, message: `Check your inbox to confirm ${email}.` });
}

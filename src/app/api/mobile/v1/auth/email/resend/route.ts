import { authClient } from "@/lib/auth/users";
import { confirmUrl } from "@/lib/auth/accounts";
import { authJson, emailAllowed, ipAllowed, settle, tooMany } from "@/lib/auth/limits";
import { isValidEmail, normalizeEmail } from "@/lib/auth/password";
import { readJson } from "@/lib/mobile/http";

/**
 * POST { email } → always the same answer: a new confirmation link goes out only
 * if an account is waiting for one, and nobody can tell from here which it was.
 */
export async function POST(request: Request) {
  const started = Date.now();
  if (!(await ipAllowed(request, "eresend", 20, 3600))) return tooMany();
  const body = await readJson<{ email?: unknown }>(request);
  const email = typeof body?.email === "string" ? normalizeEmail(body.email) : "";
  if (!isValidEmail(email)) return authJson({ error: "Enter a valid email address." }, 400);
  if (await emailAllowed("eresend", email, 3, 3600)) {
    await authClient().auth.resend({ type: "signup", email, options: { emailRedirectTo: confirmUrl() } });
  }
  await settle(started);
  return authJson({ ok: true, message: `If ${email} is waiting for confirmation, a new link is on its way.` });
}

import { authClient } from "@/lib/auth/users";
import { resetUrl } from "@/lib/auth/accounts";
import { authJson, emailAllowed, ipAllowed, settle, tooMany } from "@/lib/auth/limits";
import { isValidEmail, normalizeEmail } from "@/lib/auth/password";
import { readJson } from "@/lib/mobile/http";

/**
 * POST { email } → always the same answer. If the address has an account,
 * Supabase emails a link to /movescore/auth/reset, where a new password is set.
 */
export async function POST(request: Request) {
  const started = Date.now();
  if (!(await ipAllowed(request, "eforgot", 20, 3600))) return tooMany();
  const body = await readJson<{ email?: unknown }>(request);
  const email = typeof body?.email === "string" ? normalizeEmail(body.email) : "";
  if (!isValidEmail(email)) return authJson({ error: "Enter a valid email address." }, 400);
  if (await emailAllowed("eforgot", email, 3, 3600)) {
    await authClient().auth.resetPasswordForEmail(email, { redirectTo: resetUrl() });
  }
  await settle(started);
  return authJson({ ok: true, message: `If there's a Move Score account for ${email}, we've emailed a link to choose a new password.` });
}

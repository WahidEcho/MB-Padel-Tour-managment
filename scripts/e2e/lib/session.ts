/**
 * Mints a signed session token for end-to-end runs, using the app's own signing
 * scheme (see `src/lib/auth.ts`).
 *
 * This exists so an automated run never has to type an access code into the
 * login form. It is not a back door: it needs `AUTH_SECRET`, the same secret the
 * server verifies with, so anything that can run this could already sign tokens.
 * Run scripts with `--env-file=.env.local` so the secret comes from the
 * environment and never from a literal.
 *
 *   npx tsx --env-file=.env.local scripts/e2e/lib/session.ts        # prints a cookie header
 *   npx tsx --env-file=.env.local scripts/e2e/lib/session.ts referee
 */
import { createHmac } from "crypto";

export type Role = "admin" | "manager" | "referee" | "operator";

export const COOKIE_NAME = "mb_session";
const SESSION_HOURS = 24;

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET must be set (run with --env-file=.env.local)");
  return s;
}

/** Same payload and signature as `createSessionToken` in src/lib/auth.ts. */
export function sessionToken(role: Role = "admin", hours = SESSION_HOURS): string {
  const payload = `${role}.${Date.now() + hours * 3600_000}`;
  const sig = createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/** Ready to pass as a `Cookie:` request header. */
export function cookieHeader(role: Role = "admin"): string {
  return `${COOKIE_NAME}=${sessionToken(role)}`;
}

/** `fetch` headers for an authenticated request. */
export function authHeaders(role: Role = "admin", extra: Record<string, string> = {}) {
  return { Cookie: cookieHeader(role), ...extra };
}

export const BASE_URL = process.env.BASE_URL ?? "http://localhost:3001";

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  const role = (process.argv[2] as Role) ?? "admin";
  process.stdout.write(`${cookieHeader(role)}\n`);
}

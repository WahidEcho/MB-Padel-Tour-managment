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
import { signStaffToken, staffSecret, type StaffTokenPayload } from "../../../src/lib/auth/staffToken";

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

/**
 * An organisation staff token (`mbs1.`), the kind personal accounts and event
 * codes get (src/lib/auth/staffToken.ts). Needs the server's STAFF_SESSION_SECRET
 * in the environment (the server is a production build, which requires it).
 */
export function staffToken(
  p:
    | { kind: "member"; userId: string; orgId: string; role: "owner" | "admin" | "manager" | "referee" | "operator" }
    // Every referee code signs in with a PIN: `referee` names the referee and their sign-in row (refereeCodeToken in fixtures.ts).
    | { kind: "code"; codeId: string; orgId: string; role: "referee" | "operator"; tournamentId?: string | null; referee?: { id: string; sessionId: string } },
  opts: { hours?: number; now?: number; secret?: string } = {},
): string {
  const now = opts.now ?? Date.now();
  const exp = now + (opts.hours ?? SESSION_HOURS) * 3600_000;
  const payload: StaffTokenPayload =
    p.kind === "member"
      ? { v: 1, k: "m", u: p.userId, o: p.orgId, r: p.role, iat: now, exp }
      : { v: 1, k: "c", c: p.codeId, o: p.orgId, r: p.role, t: p.tournamentId ?? null, ...(p.referee ? { p: p.referee.id, s: p.referee.sessionId } : {}), iat: now, exp };
  return signStaffToken(payload, opts.secret ?? staffSecret({ ...process.env, NODE_ENV: "production" }));
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

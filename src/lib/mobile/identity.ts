/**
 * Who is calling a personal app route: a signed-in user, or a guest phone.
 *
 * Guests are identified by an installation token the server signed when the
 * phone registered (POST /api/mobile/v1/devices). Users send their Supabase
 * session as a bearer token, verified here against the project's public signing
 * keys, so no Supabase key ever ships inside the app.
 */
import { createHmac, timingSafeEqual } from "crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

export type Owner = { kind: "user"; id: string } | { kind: "install"; id: string };

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET must be set");
  return s;
}

export function installToken(installationId: string): string {
  const sig = createHmac("sha256", secret()).update(`install:${installationId}`).digest("base64url");
  return `${installationId}.${sig}`;
}

export function verifyInstallToken(token: string | null | undefined): string | null {
  if (!token) return null;
  const i = token.lastIndexOf(".");
  if (i < 1) return null;
  const id = token.slice(0, i);
  const expected = installToken(id).slice(i + 1);
  const sig = token.slice(i + 1);
  if (sig.length !== expected.length) return null;
  return timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? id : null;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function keys() {
  if (!jwks) {
    const url = process.env.SUPABASE_URL;
    if (!url) throw new Error("SUPABASE_URL must be set");
    jwks = createRemoteJWKSet(new URL(`${url}/auth/v1/.well-known/jwks.json`));
  }
  return jwks;
}

/** The Supabase user id of a valid access token, or null. */
export async function verifyUserToken(token: string | null | undefined): Promise<string | null> {
  if (!token || token.split(".").length !== 3) return null;
  try {
    const { payload } = await jwtVerify(token, keys(), {
      issuer: `${process.env.SUPABASE_URL}/auth/v1`,
      audience: "authenticated",
    });
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

/** The caller of a personal route. A valid user session wins over the install token. */
export async function ownerOf(request: Request): Promise<{ owner: Owner | null; installationId: string | null }> {
  const installationId = verifyInstallToken(request.headers.get("x-install-token"));
  const auth = request.headers.get("authorization");
  const bearer = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
  const userId = await verifyUserToken(bearer);
  if (userId) return { owner: { kind: "user", id: userId }, installationId };
  if (installationId) return { owner: { kind: "install", id: installationId }, installationId };
  return { owner: null, installationId: null };
}

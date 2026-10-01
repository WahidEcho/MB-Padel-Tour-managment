/**
 * Spectator accounts: Apple and Google sign-in through Supabase Auth.
 *
 * The app signs in natively and sends the provider's identity token here; the
 * server exchanges it for a Supabase session on a client made for this one
 * request (never the shared db() client, which would then act as that user).
 */
import { createClient } from "@supabase/supabase-js";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { importPKCS8, SignJWT } from "jose";

export function authClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_KEY must be set");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

function vaultKey(): Buffer {
  return createHash("sha256").update(`apple-token:${process.env.AUTH_SECRET ?? ""}`).digest();
}

export function sealToken(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", vaultKey(), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}

export function openToken(sealed: string): string | null {
  try {
    const [iv, tag, body] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
    const d = createDecipheriv("aes-256-gcm", vaultKey(), iv!);
    d.setAuthTag(tag!);
    return Buffer.concat([d.update(body!), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Sign in with Apple's client secret, a short-lived ES256 JWT (needs the Sign in with Apple key). */
async function appleClientSecret(): Promise<string | null> {
  const { APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_SIGNIN_KEY_P8, APPLE_CLIENT_ID } = process.env;
  if (!APPLE_TEAM_ID || !APPLE_KEY_ID || !APPLE_SIGNIN_KEY_P8 || !APPLE_CLIENT_ID) return null;
  const key = await importPKCS8(APPLE_SIGNIN_KEY_P8.replace(/\\n/g, "\n"), "ES256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: APPLE_KEY_ID })
    .setIssuer(APPLE_TEAM_ID)
    .setIssuedAt()
    .setExpirationTime("5m")
    .setAudience("https://appleid.apple.com")
    .setSubject(APPLE_CLIENT_ID)
    .sign(key);
}

/** Exchanges Apple's one-time authorisation code for a refresh token, kept only to revoke it on deletion. */
export async function appleRefreshToken(authorizationCode: string): Promise<string | null> {
  const secret = await appleClientSecret();
  if (!secret) return null;
  const res = await fetch("https://appleid.apple.com/auth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.APPLE_CLIENT_ID!, client_secret: secret, code: authorizationCode, grant_type: "authorization_code" }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { refresh_token?: string };
  return json.refresh_token ?? null;
}

export async function revokeApple(refreshToken: string): Promise<boolean> {
  const secret = await appleClientSecret();
  if (!secret) return false;
  const res = await fetch("https://appleid.apple.com/auth/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.APPLE_CLIENT_ID!, client_secret: secret, token: refreshToken, token_type_hint: "refresh_token" }),
  });
  return res.ok;
}

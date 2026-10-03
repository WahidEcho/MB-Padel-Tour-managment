/**
 * Spectator accounts: Apple and Google sign-in through Supabase Auth.
 *
 * Apple on iPhone signs in natively and sends its identity token here. Google
 * signs in through Supabase's own OAuth flow in the app's browser sheet (PKCE)
 * and sends the returned code and its verifier here. Either way the server makes
 * the Supabase session on a client made for this one request (never the shared
 * db() client, which would then act as that user).
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

/**
 * Trades a PKCE authorisation code (from Supabase's redirect back to the app)
 * and the app's code verifier for a session. The verifier sits in this client's
 * throwaway storage, where supabase-js looks for it.
 */
export async function exchangeOAuthCode(code: string, codeVerifier: string) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_KEY must be set");
  // supabase-js clears stored items while it initialises, so the verifier is answered
  // for its key whatever happened to the rest of this throwaway storage. Stored
  // values are JSON, as supabase-js writes them.
  const VERIFIER_KEY = "ms-oauth-code-verifier";
  const stored = JSON.stringify(codeVerifier);
  const mem = new Map<string, string>();
  const client = createClient(url, key, {
    auth: {
      flowType: "pkce",
      storageKey: "ms-oauth",
      storage: {
        getItem: (k) => (k === VERIFIER_KEY ? stored : (mem.get(k) ?? null)),
        setItem: (k, v) => void mem.set(k, v),
        removeItem: (k) => void mem.delete(k),
      },
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  return client.auth.exchangeCodeForSession(code);
}

export interface AuthProviders {
  google: boolean;
  apple: boolean;
  /** Email + password sign-up and sign-in (Supabase's Email provider). */
  email: boolean;
  /** Player-code sign-in, which needs Supabase's anonymous sign-ins. */
  playerCode: boolean;
}

let providersCache: { at: number; value: Promise<AuthProviders> } | null = null;

/**
 * Which sign-in providers are switched on in Supabase Auth (its public settings),
 * so the app shows the Google button, the email forms and "I have a player code"
 * as soon as each is enabled there (player codes need anonymous sign-ins).
 * Unknown (unreachable, stand-in without auth) reads as off.
 */
export function authProviders(): Promise<AuthProviders> {
  if (providersCache && Date.now() - providersCache.at < 60_000) return providersCache.value;
  const value = (async (): Promise<AuthProviders> => {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY;
    if (!url || !key) return { google: false, apple: false, email: false, playerCode: false };
    try {
      const res = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key }, signal: AbortSignal.timeout(3000), cache: "no-store" });
      if (!res.ok) throw new Error(`settings ${res.status}`);
      const j = (await res.json()) as { external?: Record<string, unknown> };
      return {
        google: j.external?.google === true,
        apple: j.external?.apple === true,
        email: j.external?.email === true,
        playerCode: j.external?.anonymous_users === true,
      };
    } catch {
      providersCache = null; // try again on the next request
      return { google: false, apple: false, email: false, playerCode: false };
    }
  })();
  providersCache = { at: Date.now(), value };
  return value;
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

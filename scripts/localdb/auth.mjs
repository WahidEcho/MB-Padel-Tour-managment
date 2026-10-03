/**
 * The slice of Supabase Auth (GoTrue) the Move Score sign-in uses, for the local
 * stand-in: provider settings, the PKCE OAuth round trip, refresh, the JWKS the
 * server verifies access tokens with, and deleting a user.
 *
 * `/authorize` plays the part of Google and the person tapping "Continue": it
 * sends the browser straight back to `redirect_to?code=…`. The code is bound to
 * the S256 challenge, and `/token?grant_type=pkce` only trades it with the
 * verifier that hashes to it, once — the checks the real service makes.
 *
 *   LOCALDB_AUTH_GOOGLE=off   reports Google as switched off (the button hides)
 *   ?login_hint=<email>       on /authorize picks which test person signs in
 */
import { createHash, createSign, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const KID = `localdb-${randomUUID().slice(0, 8)}`;
const JWK = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "ES256", use: "sig" };

const users = new Map(); // email -> user
const codes = new Map(); // auth code -> { challenge, userId, redirectTo, at }
const refresh = new Map(); // refresh token -> userId

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function jwt(payload) {
  const head = b64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: KID }));
  const body = b64url(JSON.stringify(payload));
  const sig = createSign("SHA256").update(`${head}.${body}`).sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${b64url(sig)}`;
}

function userFor(email) {
  let u = users.get(email);
  if (!u) {
    const name = email.split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const now = new Date().toISOString();
    u = {
      id: randomUUID(),
      aud: "authenticated",
      role: "authenticated",
      email,
      app_metadata: { provider: "google", providers: ["google"] },
      user_metadata: { full_name: name, name, email, avatar_url: "https://lh3.googleusercontent.com/a/localdb-avatar", email_verified: true },
      identities: [],
      created_at: now,
      updated_at: now,
    };
    users.set(email, u);
  }
  return u;
}

function sessionFor(issuer, user) {
  const now = Math.floor(Date.now() / 1000);
  const rt = b64url(randomBytes(24));
  refresh.set(rt, user.id);
  const access_token = jwt({ iss: issuer, sub: user.id, aud: "authenticated", role: "authenticated", email: user.email, iat: now, exp: now + 3600, session_id: randomUUID() });
  return { access_token, token_type: "bearer", expires_in: 3600, expires_at: now + 3600, refresh_token: rt, user };
}

const oauthError = (send, res, status, error_code, msg) => send(res, status, { code: status, error_code, msg });

/** Handles /auth/v1/*; returns false for anything else. */
export function handleAuth({ req, url, body, res, send, port }) {
  if (!url.pathname.startsWith("/auth/v1/")) return false;
  const issuer = `http://localhost:${port}/auth/v1`;
  const route = url.pathname.slice("/auth/v1".length);
  const google = process.env.LOCALDB_AUTH_GOOGLE !== "off";

  if (route === "/settings" && req.method === "GET") {
    send(res, 200, { external: { google, apple: false, email: false }, disable_signup: false, mailer_autoconfirm: false });
    return true;
  }
  if (route === "/.well-known/jwks.json" && req.method === "GET") {
    send(res, 200, { keys: [JWK] });
    return true;
  }
  if (route === "/authorize" && req.method === "GET") {
    const provider = url.searchParams.get("provider");
    const redirectTo = url.searchParams.get("redirect_to");
    const challenge = url.searchParams.get("code_challenge");
    const method = (url.searchParams.get("code_challenge_method") ?? "").toLowerCase();
    if (provider !== "google" || !google) return oauthError(send, res, 400, "validation_failed", "Unsupported provider: provider is not enabled"), true;
    if (!redirectTo || !challenge || method !== "s256") return oauthError(send, res, 400, "validation_failed", "PKCE flow requires code_challenge and code_challenge_method=s256"), true;
    const user = userFor(url.searchParams.get("login_hint") || "localdb.fan@example.com");
    const code = randomUUID();
    codes.set(code, { challenge, userId: user.id, at: Date.now() });
    const sep = redirectTo.includes("?") ? "&" : "?";
    res.writeHead(302, { Location: `${redirectTo}${sep}code=${code}` });
    res.end();
    return true;
  }
  if (route === "/token" && req.method === "POST") {
    const grant = url.searchParams.get("grant_type");
    const b = body ? JSON.parse(body) : {};
    if (grant === "pkce") {
      const entry = codes.get(b.auth_code);
      codes.delete(b.auth_code); // one use, right or wrong
      if (!entry || Date.now() - entry.at > 5 * 60_000) return oauthError(send, res, 404, "flow_state_not_found", "invalid flow state, no valid flow state found"), true;
      const hashed = createHash("sha256").update(String(b.code_verifier ?? "")).digest("base64url");
      if (hashed !== entry.challenge) return oauthError(send, res, 403, "bad_code_verifier", "code challenge does not match previously saved code verifier"), true;
      const user = [...users.values()].find((u) => u.id === entry.userId);
      send(res, 200, sessionFor(issuer, user));
      return true;
    }
    if (grant === "refresh_token") {
      const userId = refresh.get(b.refresh_token);
      refresh.delete(b.refresh_token);
      const user = userId && [...users.values()].find((u) => u.id === userId);
      if (!user) return oauthError(send, res, 400, "refresh_token_not_found", "Invalid Refresh Token: Refresh Token Not Found"), true;
      send(res, 200, sessionFor(issuer, user));
      return true;
    }
    if (grant === "id_token") return oauthError(send, res, 400, "validation_failed", "localdb: id_token sign-in is not emulated"), true;
    return oauthError(send, res, 400, "unsupported_grant_type", `localdb: grant_type ${grant} is not emulated`), true;
  }
  const del = /^\/admin\/users\/([0-9a-f-]{36})$/.exec(route);
  if (del && req.method === "DELETE") {
    for (const [email, u] of users) if (u.id === del[1]) users.delete(email);
    send(res, 200, {});
    return true;
  }
  send(res, 404, { code: 404, error_code: "not_found", msg: `localdb: no auth route ${route}` });
  return true;
}

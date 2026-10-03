/**
 * The slice of Supabase Auth (GoTrue) Move Score uses, for the local stand-in:
 * provider settings, the PKCE OAuth round trip, email + password sign-up with
 * confirmation, password sign-in, resend, recovery, verifying email links and
 * six-digit codes, anonymous sign-in (player codes), changing one's own email and
 * password, sign-out, refresh, the JWKS the server verifies access tokens with,
 * and deleting a user (admin only, as in production).
 *
 * `/authorize` plays the part of Google and the person tapping "Continue": it
 * sends the browser straight back to `redirect_to?code=…`. The code is bound to
 * the S256 challenge, and `/token?grant_type=pkce` only trades it with the
 * verifier that hashes to it, once — the checks the real service makes.
 *
 * Emails are not sent: they land in a mailbox the E2E scripts read,
 * GET /auth/v1/_localdb/mail?to=<email>, each with the link the branded
 * templates make (`<redirect_to>?token_hash=…&type=…`) and the six-digit code.
 *
 *   LOCALDB_AUTH_GOOGLE=off   reports Google as switched off (the button hides)
 *   LOCALDB_AUTH_EMAIL=off    reports the Email provider as off
 *   LOCALDB_AUTH_ANON=off     anonymous sign-ins off (player-code sign-in refused)
 *   LOCALDB_AUTH_DOWN=1       refresh answers 503 (also POST /auth/v1/_localdb/down {"down":true|false})
 *   LOCALDB_SERVICE_KEY=…     the "secret key" admin calls need (default local-stand-in-secret);
 *                             the stand-in's usual key is the anon key, so admin calls fail,
 *                             as they do in production today
 *   ?login_hint=<email>       on /authorize picks which test person signs in
 */
import { createHash, createSign, createVerify, generateKeyPairSync, randomBytes, randomInt, randomUUID } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const KID = `localdb-${randomUUID().slice(0, 8)}`;
const JWK = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "ES256", use: "sig" };

const users = new Map(); // id -> user (with a private `_pw` hash)
const codes = new Map(); // auth code -> { challenge, userId, at }
const refresh = new Map(); // refresh token -> { userId, sessionId }
const sessions = new Map(); // session id -> user id
const mail = []; // { to, kind, type, token_hash, otp, redirect_to, link, userId, at, used }
let down = process.env.LOCALDB_AUTH_DOWN === "1"; // refresh answers 503 (POST /auth/v1/_localdb/down {down})

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const pwHash = (p) => createHash("sha256").update(`localdb:${p}`).digest("hex");
const now = () => new Date().toISOString();
const byEmail = (email) => [...users.values()].find((u) => u.email && u.email === email);
const publicUser = (u) => {
  const { _pw, ...rest } = u;
  void _pw;
  return rest;
};

function jwt(payload) {
  const head = b64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: KID }));
  const body = b64url(JSON.stringify(payload));
  const sig = createSign("SHA256").update(`${head}.${body}`).sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${b64url(sig)}`;
}

/** The claims of a valid access token whose session still exists, or null. */
function readJwt(token) {
  const parts = (token ?? "").split(".");
  if (parts.length !== 3) return null;
  const ok = createVerify("SHA256").update(`${parts[0]}.${parts[1]}`).verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(parts[2], "base64url"));
  if (!ok) return null;
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  if (claims.exp * 1000 < Date.now()) return null;
  return claims;
}

function newUser(fields) {
  const u = {
    id: randomUUID(),
    aud: "authenticated",
    role: "authenticated",
    email: "",
    phone: "",
    app_metadata: {},
    user_metadata: {},
    identities: [],
    is_anonymous: false,
    created_at: now(),
    updated_at: now(),
    ...fields,
  };
  users.set(u.id, u);
  return u;
}

function userFor(email) {
  let u = byEmail(email);
  if (!u) {
    const name = email.split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    u = newUser({
      email,
      email_confirmed_at: now(),
      app_metadata: { provider: "google", providers: ["google"] },
      user_metadata: { full_name: name, name, email, avatar_url: "https://lh3.googleusercontent.com/a/localdb-avatar", email_verified: true },
    });
  }
  return u;
}

function sessionFor(issuer, user, sessionId = randomUUID()) {
  const t = Math.floor(Date.now() / 1000);
  const ttl = Number(process.env.LOCALDB_JWT_TTL || 3600);
  const rt = b64url(randomBytes(24));
  sessions.set(sessionId, user.id);
  refresh.set(rt, { userId: user.id, sessionId });
  const access_token = jwt({
    iss: issuer,
    sub: user.id,
    aud: "authenticated",
    role: "authenticated",
    email: user.email,
    is_anonymous: user.is_anonymous === true,
    iat: t,
    exp: t + ttl,
    session_id: sessionId,
  });
  return { access_token, token_type: "bearer", expires_in: ttl, expires_at: t + ttl, refresh_token: rt, user: publicUser(user) };
}

// The `type` in the link each kind of email carries (supabase/email-templates).
const LINK_TYPE = { signup: "email", recovery: "recovery", email_change: "email_change" };

function sendMail({ to, kind, user, redirectTo, site }) {
  const token_hash = randomBytes(20).toString("hex");
  const otp = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const base = redirectTo || site;
  const link = `${base}${base.includes("?") ? "&" : "?"}token_hash=${token_hash}&type=${LINK_TYPE[kind]}`;
  mail.push({ to, kind, type: LINK_TYPE[kind], token_hash, otp, redirect_to: redirectTo || null, link, userId: user.id, at: Date.now(), used: false });
}

const err = (send, res, status, error_code, msg, extra = {}) => send(res, status, { code: status, error_code, msg, ...extra });
const isEmail = (e) => typeof e === "string" && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(e);

/** Handles /auth/v1/*; returns false for anything else. */
export function handleAuth({ req, url, body, res, send, port }) {
  if (!url.pathname.startsWith("/auth/v1/")) return false;
  const issuer = `http://localhost:${port}/auth/v1`;
  const site = process.env.LOCALDB_SITE_URL || "http://localhost:3000";
  const route = url.pathname.slice("/auth/v1".length);
  const google = process.env.LOCALDB_AUTH_GOOGLE !== "off";
  const emailOn = process.env.LOCALDB_AUTH_EMAIL !== "off";
  const anonOn = process.env.LOCALDB_AUTH_ANON !== "off";
  const b = (() => {
    try {
      return body ? JSON.parse(body) : {};
    } catch {
      return {};
    }
  })();
  const redirectTo = url.searchParams.get("redirect_to");
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const me = () => {
    const claims = readJwt(bearer);
    if (!claims) return { error: [401, "bad_jwt", "invalid JWT: unable to parse or verify signature, token is expired"] };
    if (!sessions.has(claims.session_id)) return { error: [403, "session_not_found", "Session from session_id claim in JWT does not exist"] };
    const user = users.get(claims.sub);
    if (!user) return { error: [403, "user_not_found", "User from sub claim in JWT does not exist"] };
    return { user, claims };
  };

  if (route === "/settings" && req.method === "GET") {
    send(res, 200, { external: { google, apple: false, email: emailOn, anonymous_users: anonOn, phone: false }, disable_signup: false, mailer_autoconfirm: false });
    return true;
  }
  if (route === "/.well-known/jwks.json" && req.method === "GET") {
    send(res, 200, { keys: [JWK] });
    return true;
  }
  if (route === "/_localdb/mail" && req.method === "GET") {
    const to = url.searchParams.get("to");
    send(res, 200, mail.filter((m) => !to || m.to === to));
    return true;
  }
  if (route === "/_localdb/down" && req.method === "POST") {
    down = b.down === true;
    send(res, 200, { down });
    return true;
  }
  if (route === "/authorize" && req.method === "GET") {
    const provider = url.searchParams.get("provider");
    const challenge = url.searchParams.get("code_challenge");
    const method = (url.searchParams.get("code_challenge_method") ?? "").toLowerCase();
    if (provider !== "google" || !google) return err(send, res, 400, "validation_failed", "Unsupported provider: provider is not enabled"), true;
    if (!redirectTo || !challenge || method !== "s256") return err(send, res, 400, "validation_failed", "PKCE flow requires code_challenge and code_challenge_method=s256"), true;
    const user = userFor(url.searchParams.get("login_hint") || "localdb.fan@example.com");
    const code = randomUUID();
    codes.set(code, { challenge, userId: user.id, at: Date.now() });
    const sep = redirectTo.includes("?") ? "&" : "?";
    res.writeHead(302, { Location: `${redirectTo}${sep}code=${code}` });
    res.end();
    return true;
  }

  if (route === "/signup" && req.method === "POST") {
    if (!b.email && !b.password && !b.phone) {
      if (!anonOn) return err(send, res, 422, "anonymous_provider_disabled", "Anonymous sign-ins are disabled"), true;
      const user = newUser({ is_anonymous: true, user_metadata: b.data ?? {}, app_metadata: {} });
      send(res, 200, sessionFor(issuer, user));
      return true;
    }
    if (!emailOn) return err(send, res, 422, "email_provider_disabled", "Email signups are disabled"), true;
    const email = String(b.email ?? "").trim().toLowerCase();
    if (!isEmail(email)) return err(send, res, 400, "email_address_invalid", `Email address "${email}" is invalid`), true;
    if (String(b.password ?? "").length < 6) return err(send, res, 422, "weak_password", "Password should be at least 6 characters.", { weak_password: { reasons: ["length"] } }), true;
    const existing = byEmail(email);
    if (existing && existing.email_confirmed_at) {
      // Supabase hides that the address is taken: a look-alike user, and no email.
      send(res, 200, { id: randomUUID(), aud: "authenticated", role: "authenticated", email, app_metadata: { provider: "email", providers: ["email"] }, user_metadata: {}, identities: [], created_at: now(), updated_at: now(), is_anonymous: false });
      return true;
    }
    const user =
      existing ??
      newUser({ email, app_metadata: { provider: "email", providers: ["email"] }, user_metadata: { ...(b.data ?? {}), email, email_verified: false }, email_confirmed_at: null });
    user._pw = pwHash(b.password);
    sendMail({ to: email, kind: "signup", user, redirectTo, site });
    send(res, 200, publicUser(user));
    return true;
  }

  if (route === "/resend" && req.method === "POST") {
    const email = String(b.email ?? "").trim().toLowerCase();
    const user = byEmail(email);
    if (b.type === "signup" && user && !user.email_confirmed_at) sendMail({ to: email, kind: "signup", user, redirectTo, site });
    send(res, 200, {});
    return true;
  }

  if (route === "/recover" && req.method === "POST") {
    const email = String(b.email ?? "").trim().toLowerCase();
    const user = byEmail(email);
    if (user) sendMail({ to: email, kind: "recovery", user, redirectTo, site });
    send(res, 200, {});
    return true;
  }

  if (route === "/verify" && req.method === "POST") {
    const kind = b.type === "email" || b.type === "signup" ? "signup" : b.type;
    const fresh = (m) => !m.used && Date.now() - m.at < 3600_000 && m.kind === kind;
    const latestFor = (to) => [...mail].reverse().find((m) => m.to === to && m.kind === kind);
    let m = null;
    if (b.token_hash) m = mail.find((x) => x.token_hash === b.token_hash && fresh(x)) ?? null;
    else if (b.email && b.token) {
      // Only the newest email's code works, as in Supabase.
      const last = latestFor(String(b.email).trim().toLowerCase());
      m = last && fresh(last) && last.otp === String(b.token) ? last : null;
    }
    const user = m && users.get(m.userId);
    if (!m || !user) return err(send, res, 403, "otp_expired", "Email link is invalid or has expired"), true;
    m.used = true;
    if (kind === "signup") user.email_confirmed_at = user.email_confirmed_at ?? now();
    if (kind === "email_change") {
      user.email = user.new_email;
      user.new_email = null;
      user.email_confirmed_at = now();
      user.is_anonymous = false;
      user.app_metadata = { provider: "email", providers: ["email"] };
    }
    user.updated_at = now();
    send(res, 200, sessionFor(issuer, user));
    return true;
  }

  if (route === "/user" && (req.method === "GET" || req.method === "PUT")) {
    const who = me();
    if (who.error) return err(send, res, ...who.error), true;
    const user = who.user;
    if (req.method === "GET") return send(res, 200, publicUser(user)), true;
    if (b.email !== undefined) {
      const email = String(b.email).trim().toLowerCase();
      if (!isEmail(email)) return err(send, res, 400, "email_address_invalid", `Email address "${email}" is invalid`), true;
      const other = byEmail(email);
      if (other && other.id !== user.id) return err(send, res, 422, "email_exists", "A user with this email address has already been registered"), true;
      if (email !== user.email) {
        user.new_email = email;
        sendMail({ to: email, kind: "email_change", user, redirectTo, site });
      }
    }
    if (b.password !== undefined) {
      if (user.is_anonymous && !user.email) return err(send, res, 422, "validation_failed", "Updating password of an anonymous user without an email or phone is not allowed"), true;
      if (String(b.password).length < 6) return err(send, res, 422, "weak_password", "Password should be at least 6 characters.", { weak_password: { reasons: ["length"] } }), true;
      if (user._pw === pwHash(b.password)) return err(send, res, 422, "same_password", "New password should be different from the old password."), true;
      user._pw = pwHash(b.password);
    }
    if (b.data) user.user_metadata = { ...user.user_metadata, ...b.data };
    user.updated_at = now();
    send(res, 200, publicUser(user));
    return true;
  }

  if (route === "/logout" && req.method === "POST") {
    const who = me();
    if (who.error) return err(send, res, ...who.error), true;
    const scope = url.searchParams.get("scope") ?? "global";
    for (const [rt, e] of refresh) {
      if (scope === "global" ? e.userId === who.user.id : e.sessionId === who.claims.session_id) refresh.delete(rt);
    }
    for (const [sid, uid] of sessions) {
      if (scope === "global" ? uid === who.user.id : sid === who.claims.session_id) sessions.delete(sid);
    }
    res.writeHead(204);
    res.end();
    return true;
  }

  if (route === "/token" && req.method === "POST") {
    const grant = url.searchParams.get("grant_type");
    if (grant === "pkce") {
      const entry = codes.get(b.auth_code);
      codes.delete(b.auth_code); // one use, right or wrong
      if (!entry || Date.now() - entry.at > 5 * 60_000) return err(send, res, 404, "flow_state_not_found", "invalid flow state, no valid flow state found"), true;
      const hashed = createHash("sha256").update(String(b.code_verifier ?? "")).digest("base64url");
      if (hashed !== entry.challenge) return err(send, res, 403, "bad_code_verifier", "code challenge does not match previously saved code verifier"), true;
      send(res, 200, sessionFor(issuer, users.get(entry.userId)));
      return true;
    }
    if (grant === "password") {
      if (!emailOn) return err(send, res, 422, "email_provider_disabled", "Email logins are disabled"), true;
      const user = byEmail(String(b.email ?? "").trim().toLowerCase());
      if (!user || !user._pw || user._pw !== pwHash(String(b.password ?? ""))) return err(send, res, 400, "invalid_credentials", "Invalid login credentials"), true;
      if (!user.email_confirmed_at) return err(send, res, 400, "email_not_confirmed", "Email not confirmed"), true;
      send(res, 200, sessionFor(issuer, user));
      return true;
    }
    if (grant === "refresh_token") {
      if (down) return err(send, res, 503, "unexpected_failure", "localdb: auth is down"), true;
      const entry = refresh.get(b.refresh_token);
      refresh.delete(b.refresh_token);
      if (!entry) return err(send, res, 400, "refresh_token_not_found", "Invalid Refresh Token: Refresh Token Not Found"), true;
      const user = users.get(entry.userId);
      if (!user || !sessions.has(entry.sessionId)) return err(send, res, 400, "session_not_found", "Invalid Refresh Token: Session Expired"), true;
      send(res, 200, sessionFor(issuer, user, entry.sessionId));
      return true;
    }
    if (grant === "id_token") return err(send, res, 400, "validation_failed", "localdb: id_token sign-in is not emulated"), true;
    return err(send, res, 400, "unsupported_grant_type", `localdb: grant_type ${grant} is not emulated`), true;
  }

  const del = /^\/admin\/users\/([0-9a-f-]{36})$/.exec(route);
  if (del && req.method === "DELETE") {
    const service = process.env.LOCALDB_SERVICE_KEY || "local-stand-in-secret";
    if (bearer !== service) return err(send, res, 403, "not_admin", "User not allowed"), true;
    users.delete(del[1]);
    for (const [rt, e] of refresh) if (e.userId === del[1]) refresh.delete(rt);
    for (const [sid, uid] of sessions) if (uid === del[1]) sessions.delete(sid);
    send(res, 200, {});
    return true;
  }
  send(res, 404, { code: 404, error_code: "not_found", msg: `localdb: no auth route ${route}` });
  return true;
}

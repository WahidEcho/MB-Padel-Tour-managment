/**
 * Move Score Google sign-in, end to end, the way the app does it: config says
 * Google is on, the in-app browser sheet opens the server's start route, which
 * sends it to Supabase's authorize URL with the PKCE challenge; Supabase comes
 * back to movescore://auth/callback?code=…; the app trades code + verifier for a
 * session through the server, links its phone, refreshes, and deletes the account.
 * Also: wrong verifier, replayed code, foreign redirect, bad challenge.
 *
 * Email accounts (emailAccounts below): password rules, sign-up with the
 * confirmation email (the stand-in's mailbox), the web confirm page, sign-in,
 * "confirm your email first", resend, the six-digit code, forgot password and the
 * reset page, no account enumeration, rate limits, and staying signed in: the
 * refresh route signs out only on a revoked session, never when auth is down.
 * Deleting an account without the secret key revokes its sessions and queues it.
 *
 * Runs against the local stand-in, whose ./scripts/localdb/auth.mjs plays Supabase
 * Auth and Google (the real round trip needs a person at Google's consent screen).
 *
 *   LOCALDB_PORT=54334 npm run localdb                     # another terminal
 *   SUPABASE_URL=http://localhost:54334 PUBLIC_SITE_URL=http://localhost:3084 npx next dev -p 3084
 *   BASE_URL=http://localhost:3084 SUPABASE_URL=http://localhost:54334 \
 *     npx tsx --env-file=.env.localdb scripts/e2e/mobile-signin.ts
 */
import { createHash, randomBytes, randomUUID } from "crypto";
import { db } from "../../src/lib/supabase";
import { readAuthRedirect } from "../../src/lib/mobile/oauth";
import { BASE_URL } from "./lib/session";

let failed = 0;
function check(ok: boolean, label: string, detail?: unknown) {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!ok) failed++;
}

async function call(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

const REDIRECT = "movescore://auth/callback";

function pkce() {
  const verifier = randomBytes(32).toString("hex");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** What the browser sheet does: follow redirects until it reaches the app's scheme. */
async function browse(url: string, redirectTo = REDIRECT): Promise<{ landed: string | null; hops: string[]; status: number }> {
  const hops: string[] = [];
  let at = url;
  for (let i = 0; i < 6; i++) {
    const res = await fetch(at, { redirect: "manual" });
    const loc = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !loc) return { landed: null, hops, status: res.status };
    const next = new URL(loc, at).toString();
    hops.push(next);
    if (next.startsWith(redirectTo)) return { landed: next, hops, status: res.status };
    at = next;
  }
  return { landed: null, hops, status: 0 };
}

const startUrl = (provider: string, redirectTo: string, challenge: string) =>
  `${BASE_URL}/api/mobile/v1/auth/oauth/${provider}?redirect_to=${encodeURIComponent(redirectTo)}&code_challenge=${challenge}`;

async function main() {
  const installationId = `e2e-${randomUUID()}`;
  let userId: string | null = null;
  try {
    // ---- capability flag
    const cfg = await call("GET", "/api/mobile/v1/config");
    check(cfg.status === 200 && cfg.json?.signIn?.google === true, "Config reports Google sign-in switched on in Supabase Auth", cfg.json?.signIn);

    // ---- a guest phone
    const dev = await call("POST", "/api/mobile/v1/devices", { body: { installationId, platform: "ios" } });
    const installToken = dev.json?.installToken as string;
    check(dev.status === 200 && !!installToken, "A guest phone registers");

    // ---- refusals at the start route
    const evil = await fetch(startUrl("google", "https://evil.example/cb", pkce().challenge), { redirect: "manual" });
    check(evil.status === 400, "A redirect to another website is refused outright", evil.status);
    const badChallenge = await browse(startUrl("google", REDIRECT, "too-short"));
    check(readAuthRedirect(badChallenge.landed ?? "").error === "invalid_request", "A malformed PKCE challenge goes back to the app as an error", badChallenge.landed);
    const otherProvider = await browse(startUrl("facebook", REDIRECT, pkce().challenge));
    check(readAuthRedirect(otherProvider.landed ?? "").error === "unsupported_provider", "An unknown provider goes back to the app as an error", otherProvider.landed);

    // ---- the round trip
    const a = pkce();
    const trip = await browse(startUrl("google", REDIRECT, a.challenge));
    const toSupabase = new URL(trip.hops[0] ?? "http://x");
    check(
      toSupabase.pathname === "/auth/v1/authorize" &&
        toSupabase.searchParams.get("provider") === "google" &&
        toSupabase.searchParams.get("code_challenge") === a.challenge &&
        toSupabase.searchParams.get("code_challenge_method") === "s256" &&
        toSupabase.searchParams.get("redirect_to") === REDIRECT,
      "The start route sends the sheet to Supabase's authorize URL with the challenge and the app's redirect",
      trip.hops[0],
    );
    const back = readAuthRedirect(trip.landed ?? "");
    check(!!back.code && !back.error, "Supabase sends the sheet back to movescore://auth/callback with a code", trip.landed);

    const wrong = await call("POST", "/api/mobile/v1/auth/session", { body: { provider: "google", code: back.code, codeVerifier: pkce().verifier } });
    check(wrong.status === 401, "The code is useless with another phone's verifier", wrong.status);

    const b = pkce();
    const trip2 = await browse(startUrl("google", REDIRECT, b.challenge));
    const code2 = readAuthRedirect(trip2.landed ?? "").code;
    const apple = await call("POST", "/api/mobile/v1/auth/session", { body: { provider: "apple", code: code2, codeVerifier: b.verifier } });
    check(apple.status === 400, "Apple does not take the browser-code path", apple.status);
    const ok = await call("POST", "/api/mobile/v1/auth/session", { body: { provider: "google", code: code2, codeVerifier: b.verifier } });
    userId = ok.json?.userId ?? null;
    check(
      ok.status === 200 && !!ok.json?.accessToken && !!ok.json?.refreshToken && ok.json?.provider === "google",
      "Code + the right verifier make a Move Score session, with no age question",
      { status: ok.status, error: ok.json?.error },
    );
    check(!!ok.json?.displayName && /@/.test(ok.json?.email ?? "") && /^https:\/\//.test(ok.json?.avatarUrl ?? ""), "The session carries name, email and avatar for the account screen", {
      name: ok.json?.displayName,
      email: ok.json?.email,
    });
    const replay = await call("POST", "/api/mobile/v1/auth/session", { body: { provider: "google", code: code2, codeVerifier: b.verifier } });
    check(replay.status === 401, "The same code cannot be used twice", replay.status);

    const bearer = { Authorization: `Bearer ${ok.json?.accessToken}`, "x-install-token": installToken };
    const { data: row } = await db().from("app_users").select("provider, display_name, age_confirmed_at").eq("auth_user_id", userId!).maybeSingle();
    check(row?.provider === "google" && !!row?.display_name && !row?.age_confirmed_at, "The account row is written like Apple's, with nothing about age", row);
    const me = await call("GET", "/api/mobile/v1/me/account", { headers: bearer });
    check(me.status === 200 && me.json?.user?.id === userId, "The access token is accepted on personal routes", me.json?.user);

    // ---- linked to the phone, as after Apple sign-in (registerDevice with the session)
    const link = await call("POST", "/api/mobile/v1/devices", { headers: bearer, body: { installationId, platform: "ios" } });
    const { data: device } = await db().from("push_devices").select("user_id").eq("installation_id", installationId).maybeSingle();
    check(link.status === 200 && device?.user_id === userId, "The phone is linked to the account, so its alerts arrive here", device);

    // ---- refresh
    const r = await call("POST", "/api/mobile/v1/auth/refresh", { body: { refreshToken: ok.json?.refreshToken } });
    check(r.status === 200 && !!r.json?.accessToken && r.json.refreshToken !== ok.json?.refreshToken, "The session refreshes (single-use refresh token)", r.status);

    // ---- delete
    const del = await call("DELETE", "/api/mobile/v1/me/account", { headers: { Authorization: `Bearer ${r.json?.accessToken}` } });
    const { data: gone } = await db().from("app_users").select("auth_user_id").eq("auth_user_id", userId!).maybeSingle();
    const { data: unlinked } = await db().from("push_devices").select("user_id").eq("installation_id", installationId).maybeSingle();
    check(del.status === 200 && !gone && unlinked?.user_id === null, "Deleting the account removes it and unlinks the phone", del.json);
    check(del.json?.identityDeleted === false && del.json?.sessionsRevoked === true && /secret key/.test(del.json?.note ?? ""), "With the anon key the identity stays (queued for staff), but every session is revoked and the answer says why", del.json);
    const after = await call("POST", "/api/mobile/v1/auth/refresh", { body: { refreshToken: r.json?.refreshToken } });
    check(after.status === 401 && after.json?.code === "session_revoked", "After deletion the phone's refresh token is revoked (the app signs out)", after.json);

    await emailAccounts();
  } finally {
    if (userId) await db().from("app_users").delete().eq("auth_user_id", userId);
    for (const id of cleanup) {
      await db().from("app_users").delete().eq("auth_user_id", id);
      await db().from("app_user_deletions").delete().eq("auth_user_id", id);
    }
    if (userId) await db().from("app_user_deletions").delete().eq("auth_user_id", userId);
    await db().from("push_devices").delete().eq("installation_id", installationId);
  }
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

const cleanup: string[] = [];
const AUTH = () => `${process.env.SUPABASE_URL}/auth/v1`;

interface Mail {
  to: string;
  kind: string;
  type: string;
  token_hash: string;
  otp: string;
  link: string;
}
async function inbox(to: string): Promise<Mail[]> {
  const res = await fetch(`${AUTH()}/_localdb/mail?to=${encodeURIComponent(to)}`);
  return res.ok ? ((await res.json()) as Mail[]) : [];
}
const lastMail = async (to: string) => (await inbox(to)).at(-1) ?? null;
const page = async (url: string) => {
  const res = await fetch(url);
  return { status: res.status, html: await res.text() };
};

/** Email + password accounts, the confirm and reset pages, and staying signed in. */
async function emailAccounts() {
  const tag = randomUUID().slice(0, 6);
  const email = `e2e.mail.${tag}@example.com`;
  const good = "Rally2026x";

  const cfg = await call("GET", "/api/mobile/v1/config");
  check(cfg.json?.signIn?.email === true && cfg.json?.signIn?.playerCode === true, "Config reports email and player-code sign-in switched on", cfg.json?.signIn);

  // ---- password rules (server side; the app shows the same checklist)
  for (const [pw, rule] of [["Ra1ly", "8 characters"], ["rally2026", "upper-case"], ["RALLY2026", "lower-case"], ["RallyRally", "number"], [email, "email"]] as const) {
    const r = await call("POST", "/api/mobile/v1/auth/email/signup", { body: { email, password: pw } });
    check(r.status === 400 && r.json?.code === "weak_password", `Sign-up refuses a password without ${rule}`, r.json?.error);
  }
  const badEmail = await call("POST", "/api/mobile/v1/auth/email/signup", { body: { email: "not-an-email", password: good } });
  check(badEmail.status === 400, "Sign-up refuses an invalid email", badEmail.json?.error);

  // ---- sign up → confirmation email
  const up = await call("POST", "/api/mobile/v1/auth/email/signup", { body: { email: `  ${email.toUpperCase()} `, password: good, name: "Mona Fan" } });
  check(up.status === 200 && up.json?.status === "confirm" && up.json?.email === email && /Check your inbox to confirm/.test(up.json?.message), "Sign-up answers 'Check your inbox to confirm <email>'", up.json);
  const m1 = await lastMail(email);
  const link1 = new URL(m1?.link ?? "http://x");
  check(
    m1?.kind === "signup" && link1.pathname === "/movescore/auth/confirm" && link1.searchParams.get("type") === "email" && !!link1.searchParams.get("token_hash") && link1.origin === BASE_URL,
    "Supabase sends the confirmation email, linking to /movescore/auth/confirm?token_hash=…&type=email",
    m1?.link,
  );
  const early = await call("POST", "/api/mobile/v1/auth/email/signin", { body: { email, password: good } });
  check(early.status === 403 && early.json?.code === "email_not_confirmed" && /Confirm your email first/.test(early.json?.error), "Signing in before confirming: 'Confirm your email first'", early.json);

  // ---- no enumeration: a second sign-up, resend and forgot answer alike for known and unknown addresses
  const nobody = `e2e.nobody.${tag}@example.com`;
  const upAgain = await call("POST", "/api/mobile/v1/auth/email/signup", { body: { email, password: good } });
  const upNobody = await call("POST", "/api/mobile/v1/auth/email/signup", { body: { email: `e2e.fresh.${tag}@example.com`, password: good } });
  check(upAgain.status === upNobody.status && upAgain.json?.status === upNobody.json?.status, "A second sign-up with the same email answers like a new one", [upAgain.status, upNobody.status]);
  const rs1 = await call("POST", "/api/mobile/v1/auth/email/resend", { body: { email } });
  const rs2 = await call("POST", "/api/mobile/v1/auth/email/resend", { body: { email: nobody } });
  check(rs1.status === 200 && rs2.status === 200 && rs1.json?.message.replace(email, "") === rs2.json?.message.replace(nobody, ""), "Resend answers the same for an account and for nobody", rs1.json?.message);
  const m2 = await lastMail(email);
  check(!!m2 && m2.token_hash !== m1?.token_hash, "Resend sends a new confirmation link", m2?.kind);
  check((await inbox(nobody)).length === 0, "…and nothing to an address with no account");

  // ---- the web confirm page verifies the link on the server
  const ok = await page(m2!.link);
  check(ok.status === 200 && ok.html.includes("Email confirmed") && ok.html.includes("movescore://auth/confirmed"), "The confirm page says 'Email confirmed — open Move Score' and deep-links movescore://auth/confirmed", ok.status);
  const reuse = await page(m2!.link);
  check(reuse.status === 200 && reuse.html.includes("This link has expired"), "The same link a second time says it has expired (sign in instead)");
  const junk = await page(`${BASE_URL}/movescore/auth/confirm?token_hash=abcdefabcdef&type=bogus`);
  check(junk.status === 200 && junk.html.includes("This link has expired"), "A malformed link is refused politely");

  // ---- sign in
  const wrong = await call("POST", "/api/mobile/v1/auth/email/signin", { body: { email, password: "Wrong2026x" } });
  check(wrong.status === 401 && /incorrect/.test(wrong.json?.error), "A wrong password is refused", wrong.json?.error);
  const ghost = await call("POST", "/api/mobile/v1/auth/email/signin", { body: { email: nobody, password: good } });
  check(ghost.status === 401 && ghost.json?.error === wrong.json?.error, "An unknown email gets the same answer as a wrong password");
  const si = await call("POST", "/api/mobile/v1/auth/email/signin", { body: { email, password: good } });
  const uid = si.json?.userId as string;
  if (uid) cleanup.push(uid);
  check(si.status === 200 && si.json?.provider === "email" && si.json?.registrationComplete === true && !!si.json?.refreshToken && si.json?.displayName === "Mona Fan", "Email sign-in makes the same session as Apple/Google, with the name from sign-up", { status: si.status, provider: si.json?.provider });
  const { data: row } = await db().from("app_users").select("provider, display_name, registration_complete").eq("auth_user_id", uid).maybeSingle();
  check(row?.provider === "email" && row?.registration_complete === true, "The account row is written (provider email)", row);
  const me = await call("GET", "/api/mobile/v1/me", { headers: { Authorization: `Bearer ${si.json?.accessToken}` } });
  check(me.status === 200 && me.json?.user?.registrationComplete === true && me.json?.user?.email === email, "GET /me: registration complete, with the email", me.json?.user);

  // ---- staying signed in: only a revoked session signs out
  await fetch(`${AUTH()}/_localdb/down`, { method: "POST", body: JSON.stringify({ down: true }) });
  const busy = await call("POST", "/api/mobile/v1/auth/refresh", { body: { refreshToken: si.json?.refreshToken } });
  await fetch(`${AUTH()}/_localdb/down`, { method: "POST", body: JSON.stringify({ down: false }) });
  check(busy.status === 503 && busy.json?.code === "session_retry", "Auth down: the refresh answers 503 session_retry (the app keeps the session)", busy.json);
  const r1 = await call("POST", "/api/mobile/v1/auth/refresh", { body: { refreshToken: si.json?.refreshToken } });
  check(r1.status === 200 && !!r1.json?.refreshToken, "…and the same refresh token still works afterwards", r1.status);
  const bogus = await call("POST", "/api/mobile/v1/auth/refresh", { body: { refreshToken: "not-a-real-token" } });
  check(bogus.status === 401 && bogus.json?.code === "session_revoked", "A refresh token Supabase does not know: 401 session_revoked", bogus.json);
  const { isSessionRevoked } = await import("../../src/lib/auth/sessionRules");
  check(isSessionRevoked(bogus.status, bogus.json) && !isSessionRevoked(busy.status, busy.json), "The app's rule signs out on the revoked answer only");

  // ---- the six-digit code instead of the link
  const email2 = `e2e.code.${tag}@example.com`;
  await call("POST", "/api/mobile/v1/auth/email/signup", { body: { email: email2, password: good } });
  const m3 = await lastMail(email2);
  const badCode = await call("POST", "/api/mobile/v1/auth/email/verify", { body: { email: email2, code: m3!.otp === "000000" ? "111111" : "000000" } });
  check(badCode.status === 400, "A wrong six-digit code is refused", badCode.json?.error);
  const byCode = await call("POST", "/api/mobile/v1/auth/email/verify", { body: { email: email2, code: m3!.otp } });
  if (byCode.json?.userId) cleanup.push(byCode.json.userId);
  check(byCode.status === 200 && byCode.json?.provider === "email" && !!byCode.json?.accessToken, "The code from the email confirms and signs in", byCode.status);

  // ---- forgot password → reset page
  const f1 = await call("POST", "/api/mobile/v1/auth/email/forgot", { body: { email } });
  const f2 = await call("POST", "/api/mobile/v1/auth/email/forgot", { body: { email: nobody } });
  check(f1.status === 200 && f2.status === 200 && f1.json?.message.replace(email, "") === f2.json?.message.replace(nobody, ""), "Forgot password answers the same for an account and for nobody");
  const rm = await lastMail(email);
  const rl = new URL(rm?.link ?? "http://x");
  check(rm?.kind === "recovery" && rl.pathname === "/movescore/auth/reset" && rl.searchParams.get("type") === "recovery", "The reset email links to /movescore/auth/reset?token_hash=…&type=recovery", rm?.link);
  const resetPage = await page(rm!.link);
  check(resetPage.status === 200 && resetPage.html.includes("Choose a new password") && resetPage.html.includes("token_hash"), "The reset page shows the new-password form (the token is not spent by opening it)");
  const { resetWithLink } = await import("../../src/lib/auth/links");
  const weak = await resetWithLink({ tokenHash: rl.searchParams.get("token_hash"), type: "recovery", password: "short", confirm: "short" });
  check(weak?.ok === false && !weak.accessToken, "The reset form checks the rules before spending the token", weak);
  const asEmail = await resetWithLink({ tokenHash: rl.searchParams.get("token_hash"), type: "recovery", password: "E2e.Mail.1@x.com", confirm: "E2e.Mail.1@x.com" });
  check(asEmail?.ok === true, "A good new password is set from the link", asEmail);
  const spent = await resetWithLink({ tokenHash: rl.searchParams.get("token_hash"), type: "recovery", password: "Another2026", confirm: "Another2026" });
  check(spent?.ok === false && spent.expired === true, "The link works once", spent);
  const oldPw = await call("POST", "/api/mobile/v1/auth/email/signin", { body: { email, password: good } });
  const newPw = await call("POST", "/api/mobile/v1/auth/email/signin", { body: { email, password: "E2e.Mail.1@x.com" } });
  check(oldPw.status === 401 && newPw.status === 200 && newPw.json?.userId === uid, "After the reset the new password signs in and the old one does not");
  const still = await call("POST", "/api/mobile/v1/auth/refresh", { body: { refreshToken: r1.json?.refreshToken } });
  check(still.status === 200, "A password reset does not sign the phone out", still.status);

  // ---- rate limits
  const victim = `e2e.brake.${tag}@example.com`;
  const codes: number[] = [];
  for (let i = 0; i < 11; i++) codes.push((await call("POST", "/api/mobile/v1/auth/email/signin", { body: { email: victim, password: `Guess${i}abcD` } })).status);
  check(codes.slice(0, 10).every((c) => c === 401) && codes[10] === 429, "Ten wrong passwords for one email, then the email is stopped", codes);
  const sent: number[] = [];
  for (let i = 0; i < 5; i++) sent.push((await call("POST", "/api/mobile/v1/auth/email/forgot", { body: { email } })).status);
  const mails = (await inbox(email)).filter((x) => x.kind === "recovery").length;
  check(sent.every((c) => c === 200) && mails <= 3, "Forgot password keeps answering the same, but sends at most three emails an hour per address", { sent, mails });

  // ---- deleting an email account (anon key): data gone, sessions revoked, queued for staff; signing in again starts fresh
  const del = await call("DELETE", "/api/mobile/v1/me/account", { headers: { Authorization: `Bearer ${newPw.json?.accessToken}` } });
  const { data: queued } = await db().from("app_user_deletions").select("identity_deleted, provider").eq("auth_user_id", uid).maybeSingle();
  check(del.status === 200 && del.json?.identityDeleted === false && queued?.identity_deleted === false && queued?.provider === "email", "Deletion without the secret key is recorded for staff", queued);
  const dead = await call("POST", "/api/mobile/v1/auth/refresh", { body: { refreshToken: newPw.json?.refreshToken } });
  check(dead.status === 401 && dead.json?.code === "session_revoked", "…and the deleted account's sessions are revoked", dead.json);
  const back = await call("POST", "/api/mobile/v1/auth/email/signin", { body: { email, password: "E2e.Mail.1@x.com" } });
  const { data: unqueued } = await db().from("app_user_deletions").select("auth_user_id").eq("auth_user_id", uid).maybeSingle();
  check(back.status === 200 && !unqueued, "Signing in again before staff purge it starts a fresh account (and takes it off the queue)", back.status);
}

void main();

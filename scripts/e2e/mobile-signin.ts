/**
 * Move Score Google sign-in, end to end, the way the app does it: config says
 * Google is on, the in-app browser sheet opens the server's start route, which
 * sends it to Supabase's authorize URL with the PKCE challenge; Supabase comes
 * back to movescore://auth/callback?code=…; the app trades code + verifier for a
 * session through the server, links its phone, refreshes, and deletes the account.
 * Also: wrong verifier, replayed code, foreign redirect, bad challenge.
 *
 * Runs against the local stand-in, whose ./scripts/localdb/auth.mjs plays Supabase
 * Auth and Google (the real round trip needs a person at Google's consent screen).
 *
 *   LOCALDB_PORT=54334 npm run localdb                     # another terminal
 *   SUPABASE_URL=http://localhost:54334 npx next dev -p 3084
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

    const wrong = await call("POST", "/api/mobile/v1/auth/session", { body: { provider: "google", code: back.code, codeVerifier: pkce().verifier, ageConfirmed: true } });
    check(wrong.status === 401, "The code is useless with another phone's verifier", wrong.status);

    const b = pkce();
    const trip2 = await browse(startUrl("google", REDIRECT, b.challenge));
    const code2 = readAuthRedirect(trip2.landed ?? "").code;
    const noAge = await call("POST", "/api/mobile/v1/auth/session", { body: { provider: "google", code: code2, codeVerifier: b.verifier } });
    check(noAge.status === 400, "Without the 16+ confirmation there is no account", noAge.status);
    const apple = await call("POST", "/api/mobile/v1/auth/session", { body: { provider: "apple", code: code2, codeVerifier: b.verifier, ageConfirmed: true } });
    check(apple.status === 400, "Apple does not take the browser-code path", apple.status);
    const ok = await call("POST", "/api/mobile/v1/auth/session", { body: { provider: "google", code: code2, codeVerifier: b.verifier, ageConfirmed: true } });
    userId = ok.json?.userId ?? null;
    check(
      ok.status === 200 && !!ok.json?.accessToken && !!ok.json?.refreshToken && ok.json?.provider === "google",
      "Code + the right verifier make a Move Score session",
      { status: ok.status, error: ok.json?.error },
    );
    check(!!ok.json?.displayName && /@/.test(ok.json?.email ?? "") && /^https:\/\//.test(ok.json?.avatarUrl ?? ""), "The session carries name, email and avatar for the account screen", {
      name: ok.json?.displayName,
      email: ok.json?.email,
    });
    const replay = await call("POST", "/api/mobile/v1/auth/session", { body: { provider: "google", code: code2, codeVerifier: b.verifier, ageConfirmed: true } });
    check(replay.status === 401, "The same code cannot be used twice", replay.status);

    const bearer = { Authorization: `Bearer ${ok.json?.accessToken}`, "x-install-token": installToken };
    const { data: row } = await db().from("app_users").select("provider, display_name, age_confirmed_at").eq("auth_user_id", userId!).maybeSingle();
    check(row?.provider === "google" && !!row?.display_name && !!row?.age_confirmed_at, "The account row is written like Apple's", row);
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
  } finally {
    if (userId) await db().from("app_users").delete().eq("auth_user_id", userId);
    await db().from("push_devices").delete().eq("installation_id", installationId);
  }
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

void main();

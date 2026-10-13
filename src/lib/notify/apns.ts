/**
 * iPhone lock-screen live scores (Live Activities). Expo's push service cannot
 * start or update a Live Activity, so these go straight to Apple over HTTP/2 with
 * the team's token key. Off unless APNS_KEY_P8, APNS_KEY_ID, APNS_TEAM_ID and
 * APNS_BUNDLE_ID are set and the `live_activity` flag is on. What the card shows
 * and the payloads themselves are pure, in liveActivity.ts.
 *
 * Two kinds of token, never logged:
 *   - an activity's update token (live_activity_tokens, one row per card), for
 *     update and end pushes — pushLiveActivities();
 *   - a phone's push-to-start token (live_activity_start_tokens, one per
 *     installation, iOS 17.2+), to put a new card on the lock screen without the
 *     app running — pushToStart(), at most once per phone, match and phase
 *     (live_activity_starts).
 *
 * One HTTP/2 connection carries every push of a call (Apple asks for connection
 * reuse; opening one per token gets throttled). A token is ended only when Apple
 * says it is gone (410, BadDeviceToken, Unregistered); a 403 means our key, team
 * or topic is wrong and is logged, not blamed on the phone.
 */
import http2 from "node:http2";
import { importPKCS8, SignJWT } from "jose";
import { db } from "../supabase";
import { apnsVerdict, startAlert, startPayload, updatePayload, type ApnsResult, type LiveScoreState } from "./liveActivity";

export { LIVE_ACTIVITY_NAME, apnsVerdict, liveState, upcomingState, type ApnsResult, type LiveScoreState } from "./liveActivity";

/** Pushes in flight at once on the one connection (Apple allows far more streams). */
const CONCURRENCY = 20;
const PAGE = 1000;

let cached: { jwt: string; at: number } | null = null;

async function providerToken(): Promise<string | null> {
  const { APNS_KEY_P8, APNS_KEY_ID, APNS_TEAM_ID } = process.env;
  if (!APNS_KEY_P8 || !APNS_KEY_ID || !APNS_TEAM_ID) return null;
  if (cached && Date.now() - cached.at < 40 * 60_000) return cached.jwt;
  const key = await importPKCS8(APNS_KEY_P8.replace(/\\n/g, "\n"), "ES256");
  const jwt = await new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: APNS_KEY_ID }).setIssuer(APNS_TEAM_ID).setIssuedAt().sign(key);
  cached = { jwt, at: Date.now() };
  return jwt;
}

function send(client: http2.ClientHttp2Session, token: string, jwt: string, body: string, priority: 5 | 10): Promise<ApnsResult> {
  return new Promise((resolve) => {
    let req: http2.ClientHttp2Stream;
    try {
      req = client.request({
        ":method": "POST",
        ":path": `/3/device/${token}`,
        authorization: `bearer ${jwt}`,
        // Start, update and end all go to the Live Activity topic.
        "apns-push-type": "liveactivity",
        "apns-topic": `${process.env.APNS_BUNDLE_ID}.push-type.liveactivity`,
        "apns-priority": String(priority),
        "content-type": "application/json",
      });
    } catch {
      resolve({ status: 0, reason: "session closed" });
      return;
    }
    let status = 0;
    let text = "";
    req.setEncoding("utf8");
    req.on("response", (h) => (status = Number(h[":status"]) || 0));
    req.on("data", (chunk: string) => (text += chunk));
    req.on("end", () => {
      let reason: string | null = null;
      try {
        reason = text ? ((JSON.parse(text) as { reason?: string }).reason ?? null) : null;
      } catch {
        /* not JSON */
      }
      resolve({ status, reason });
    });
    req.on("error", () => resolve({ status: 0, reason: "stream error" }));
    // A stream cut off by the connection closing never ends; settle it anyway.
    req.on("close", () => resolve({ status, reason: null }));
    req.end(body);
  });
}

type Verdict = ReturnType<typeof apnsVerdict>;

/**
 * Sends one body to many tokens over one connection. Returns each token's
 * verdict; configuration errors are logged once per kind (never the token).
 */
async function sendAll(tokens: string[], body: string, priority: 5 | 10, what: string): Promise<Map<string, Verdict>> {
  const verdicts = new Map<string, Verdict>();
  if (!tokens.length || !process.env.APNS_BUNDLE_ID) return verdicts;
  const jwt = await providerToken();
  if (!jwt) return verdicts;
  const host = process.env.APNS_SANDBOX === "1" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
  const client = http2.connect(`https://${host}`);
  client.on("error", (err) => console.error("[apns] connection error", err.message));
  const config = new Map<string, number>();
  try {
    let next = 0;
    const worker = async () => {
      while (next < tokens.length) {
        const t = tokens[next++]!;
        const r = await send(client, t, jwt, body, priority);
        const verdict = apnsVerdict(r);
        verdicts.set(t, verdict);
        if (verdict === "config") {
          const key = `${r.status} ${r.reason ?? ""}`.trim();
          config.set(key, (config.get(key) ?? 0) + 1);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tokens.length) }, worker));
  } finally {
    client.close();
  }
  for (const [reason, n] of config) {
    console.error(`[apns] ${reason} for ${n} ${what} push(es) — check APNS_KEY_ID / APNS_TEAM_ID / APNS_KEY_P8 / APNS_BUNDLE_ID`);
    // A rejected provider token is not reused for the next call.
    if (/ProviderToken/.test(reason)) cached = null;
  }
  return verdicts;
}

async function activeTokens(matchId: string): Promise<{ push_token: string; installation_id: string }[]> {
  const rows: { push_token: string; installation_id: string }[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data } = await db()
      .from("live_activity_tokens")
      .select("push_token, installation_id")
      .eq("match_id", matchId)
      .is("ended_at", null)
      .order("created_at")
      .range(from, from + PAGE - 1);
    const page = (data ?? []) as { push_token: string; installation_id: string }[];
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

/** Updates (or ends) every lock-screen card following this match. */
export async function pushLiveActivities(matchId: string, state: LiveScoreState, opts: { end?: boolean; important?: boolean } = {}) {
  if (!process.env.APNS_BUNDLE_ID) return;
  const tokens = (await activeTokens(matchId)).map((t) => t.push_token);
  if (!tokens.length) return;
  const body = JSON.stringify(updatePayload({ ...state, matchId: state.matchId ?? matchId }, { nowSec: Math.floor(Date.now() / 1000), end: opts.end }));
  const priority = opts.important || opts.end ? 10 : 5;
  const verdicts = await sendAll(tokens, body, priority, "live activity");
  const ended = opts.end ? tokens : tokens.filter((t) => verdicts.get(t) === "dead");
  for (let i = 0; i < ended.length; i += 200) {
    await db().from("live_activity_tokens").update({ ended_at: new Date().toISOString() }).in("push_token", ended.slice(i, i + 200));
  }
}

/**
 * Puts a new card for this match on the lock screens of these phones (iOS 17.2+),
 * once per phone, match and phase. Phones that already follow the match on the
 * lock screen (an open update token) get an update from pushLiveActivities
 * instead, never a second card. Returns how many starts went out.
 */
export async function pushToStart(matchId: string, state: LiveScoreState, installationIds: string[]): Promise<{ sent: number }> {
  if (!process.env.APNS_BUNDLE_ID || !installationIds.length) return { sent: 0 };
  const phase = state.phase ?? "live";
  const wanted = [...new Set(installationIds)];

  const following = new Set((await activeTokens(matchId)).map((t) => t.installation_id));
  const started = new Set<string>();
  for (let i = 0; i < wanted.length; i += 200) {
    const { data } = await db().from("live_activity_starts").select("installation_id").eq("match_id", matchId).eq("phase", phase).in("installation_id", wanted.slice(i, i + 200));
    for (const r of (data ?? []) as { installation_id: string }[]) started.add(r.installation_id);
  }
  const candidates = wanted.filter((id) => !following.has(id) && !started.has(id));
  if (!candidates.length) return { sent: 0 };

  const tokenOf = new Map<string, string>();
  for (let i = 0; i < candidates.length; i += 200) {
    const { data } = await db().from("live_activity_start_tokens").select("installation_id, token").in("installation_id", candidates.slice(i, i + 200)).is("disabled_at", null);
    for (const r of (data ?? []) as { installation_id: string; token: string }[]) tokenOf.set(r.installation_id, r.token);
  }
  const targets = candidates.filter((id) => tokenOf.has(id));
  if (!targets.length) return { sent: 0 };

  // Claimed before sending, so two calls at once do not both start a card.
  const claims = targets.map((installation_id) => ({ installation_id, match_id: matchId, phase }));
  for (let i = 0; i < claims.length; i += 200) {
    await db().from("live_activity_starts").upsert(claims.slice(i, i + 200), { onConflict: "installation_id,match_id,phase", ignoreDuplicates: true });
  }

  const full = { ...state, matchId };
  const body = JSON.stringify(startPayload(full, { nowSec: Math.floor(Date.now() / 1000), alert: startAlert(full) }));
  const tokens = targets.map((id) => tokenOf.get(id)!);
  const verdicts = await sendAll(tokens, body, 10, "live activity start");

  const dead: string[] = [];
  const unclaim: string[] = [];
  let sent = 0;
  for (const id of targets) {
    const v = verdicts.get(tokenOf.get(id)!);
    if (v === "ok") sent++;
    else if (v === "dead") dead.push(id);
    // Not sent (config, retry, or APNs off): free the claim so a later call can try again.
    else unclaim.push(id);
  }
  for (let i = 0; i < dead.length; i += 200) {
    await db().from("live_activity_start_tokens").update({ disabled_at: new Date().toISOString() }).in("installation_id", dead.slice(i, i + 200));
  }
  for (let i = 0; i < unclaim.length; i += 200) {
    await db().from("live_activity_starts").delete().eq("match_id", matchId).eq("phase", phase).in("installation_id", unclaim.slice(i, i + 200));
  }
  return { sent };
}

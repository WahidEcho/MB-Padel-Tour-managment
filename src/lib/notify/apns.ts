/**
 * iPhone lock-screen live scores (Live Activities). Expo's push service cannot
 * update a Live Activity, so these go straight to Apple over HTTP/2 with the
 * team's token key. Off unless APNS_KEY_P8, APNS_KEY_ID, APNS_TEAM_ID and
 * APNS_BUNDLE_ID are set and the `live_activity` flag is on.
 *
 * One HTTP/2 connection carries every push of a call (Apple asks for connection
 * reuse; opening one per token gets throttled). A token is ended only when Apple
 * says it is gone (410, BadDeviceToken, Unregistered); a 403 means our key, team
 * or topic is wrong and is logged, not blamed on the phone.
 */
import http2 from "node:http2";
import { importPKCS8, SignJWT } from "jose";
import { db } from "../supabase";
import type { MScore } from "../mobile/contract";

/** Must match createLiveActivity("MatchScore", …) in the app. */
export const LIVE_ACTIVITY_NAME = "MatchScore";

/** Pushes in flight at once on the one connection (Apple allows far more streams). */
const CONCURRENCY = 20;
const PAGE = 1000;
/** Reasons that mean this token will never work again. */
const DEAD_REASONS = new Set(["BadDeviceToken", "Unregistered", "ExpiredToken"]);

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

export interface LiveScoreState {
  a: string;
  b: string;
  sets: string;
  points: string;
  serving: "A" | "B" | null;
  status: string;
  court: string;
}

export function liveState(score: MScore | null, labels: { a: string; b: string; court: string; status: string }): LiveScoreState {
  return {
    a: labels.a,
    b: labels.b,
    sets: [...(score?.sets ?? []).map((s) => `${s.a}-${s.b}`), ...(score?.games ? [`${score.games.a}-${score.games.b}`] : [])].join(" "),
    points: score?.points ? `${score.points.a}-${score.points.b}` : "",
    serving: score?.serving ?? null,
    status: labels.status,
    court: labels.court,
  };
}

export interface ApnsResult {
  status: number;
  reason: string | null;
}

/** What to do with a token after Apple's answer. */
export function apnsVerdict(r: ApnsResult): "ok" | "dead" | "config" | "retry" {
  if (r.status === 200) return "ok";
  if (r.status === 410 || (r.reason && DEAD_REASONS.has(r.reason))) return "dead";
  if (r.status === 403 || r.reason === "BadTopic" || r.reason === "TopicDisallowed" || r.reason === "MissingTopic") return "config";
  return "retry";
}

function send(client: http2.ClientHttp2Session, token: string, jwt: string, body: string, priority: 5 | 10): Promise<ApnsResult> {
  return new Promise((resolve) => {
    let req: http2.ClientHttp2Stream;
    try {
      req = client.request({
        ":method": "POST",
        ":path": `/3/device/${token}`,
        authorization: `bearer ${jwt}`,
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

async function activeTokens(matchId: string): Promise<string[]> {
  const tokens: string[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data } = await db()
      .from("live_activity_tokens")
      .select("push_token")
      .eq("match_id", matchId)
      .is("ended_at", null)
      .order("created_at")
      .range(from, from + PAGE - 1);
    const page = ((data ?? []) as { push_token: string }[]).map((t) => t.push_token);
    tokens.push(...page);
    if (page.length < PAGE) return tokens;
  }
}

/** Updates (or ends) every lock-screen score following this match. */
export async function pushLiveActivities(matchId: string, state: LiveScoreState, opts: { end?: boolean; important?: boolean } = {}) {
  if (!process.env.APNS_BUNDLE_ID) return;
  const jwt = await providerToken();
  if (!jwt) return;
  const tokens = await activeTokens(matchId);
  if (!tokens.length) return;
  const host = process.env.APNS_SANDBOX === "1" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
  const now = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    aps: {
      timestamp: now,
      event: opts.end ? "end" : "update",
      // expo-widgets' content state: the activity's name and its props as a JSON string.
      "content-state": { name: LIVE_ACTIVITY_NAME, props: JSON.stringify(state) },
      "stale-date": now + 120,
      ...(opts.end ? { "dismissal-date": now + 15 * 60 } : {}),
    },
  });
  const priority = opts.important || opts.end ? 10 : 5;

  const client = http2.connect(`https://${host}`);
  client.on("error", (err) => console.error("[apns] connection error", err.message));
  const dead: string[] = [];
  const config = new Map<string, number>();
  try {
    let next = 0;
    const worker = async () => {
      while (next < tokens.length) {
        const t = tokens[next++]!;
        const r = await send(client, t, jwt, body, priority);
        const verdict = apnsVerdict(r);
        if (verdict === "dead") dead.push(t);
        else if (verdict === "config") {
          const key = `${r.status} ${r.reason ?? ""}`.trim();
          config.set(key, (config.get(key) ?? 0) + 1);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tokens.length) }, worker));
  } finally {
    client.close();
  }
  for (const [what, n] of config) {
    console.error(`[apns] ${what} for ${n} live activity push(es) — check APNS_KEY_ID / APNS_TEAM_ID / APNS_KEY_P8 / APNS_BUNDLE_ID`);
    // A rejected provider token is not reused for the next call.
    if (/ProviderToken/.test(what)) cached = null;
  }
  const ended = opts.end ? tokens : dead;
  for (let i = 0; i < ended.length; i += 200) {
    await db().from("live_activity_tokens").update({ ended_at: new Date().toISOString() }).in("push_token", ended.slice(i, i + 200));
  }
}

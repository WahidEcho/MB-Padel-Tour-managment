/**
 * iPhone lock-screen live scores (Live Activities). Expo's push service cannot
 * update a Live Activity, so these go straight to Apple over HTTP/2 with the
 * team's token key. Off unless APNS_KEY_P8, APNS_KEY_ID, APNS_TEAM_ID and
 * APNS_BUNDLE_ID are set and the `live_activity` flag is on.
 */
import http2 from "node:http2";
import { importPKCS8, SignJWT } from "jose";
import { db } from "../supabase";
import type { MScore } from "../mobile/contract";

/** Must match createLiveActivity("MatchScore", …) in the app. */
export const LIVE_ACTIVITY_NAME = "MatchScore";

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

function send(host: string, token: string, jwt: string, payload: unknown, priority: 5 | 10): Promise<number> {
  return new Promise((resolve) => {
    const client = http2.connect(`https://${host}`);
    client.on("error", () => resolve(0));
    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${token}`,
      authorization: `bearer ${jwt}`,
      "apns-push-type": "liveactivity",
      "apns-topic": `${process.env.APNS_BUNDLE_ID}.push-type.liveactivity`,
      "apns-priority": String(priority),
      "content-type": "application/json",
    });
    let status = 0;
    req.on("response", (h) => (status = Number(h[":status"]) || 0));
    req.on("end", () => {
      client.close();
      resolve(status);
    });
    req.on("error", () => {
      client.close();
      resolve(0);
    });
    req.end(JSON.stringify(payload));
  });
}

/** Updates (or ends) every lock-screen score following this match. */
export async function pushLiveActivities(matchId: string, state: LiveScoreState, opts: { end?: boolean; important?: boolean } = {}) {
  if (!process.env.APNS_BUNDLE_ID) return;
  const jwt = await providerToken();
  if (!jwt) return;
  const { data } = await db().from("live_activity_tokens").select("push_token").eq("match_id", matchId).is("ended_at", null).limit(500);
  const tokens = ((data ?? []) as { push_token: string }[]).map((t) => t.push_token);
  if (!tokens.length) return;
  const host = process.env.APNS_SANDBOX === "1" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aps: {
      timestamp: now,
      event: opts.end ? "end" : "update",
      // expo-widgets' content state: the activity's name and its props as a JSON string.
      "content-state": { name: LIVE_ACTIVITY_NAME, props: JSON.stringify(state) },
      "stale-date": now + 120,
      ...(opts.end ? { "dismissal-date": now + 15 * 60 } : {}),
    },
  };
  const bad: string[] = [];
  for (const t of tokens) {
    const status = await send(host, t, jwt, payload, opts.important || opts.end ? 10 : 5);
    if (status === 410 || status === 400) bad.push(t);
  }
  if (bad.length || opts.end) {
    await db().from("live_activity_tokens").update({ ended_at: new Date().toISOString() }).in("push_token", opts.end ? tokens : bad);
  }
}

/**
 * Starts an iPhone lock-screen live score for one match. The app shows it at
 * once; the server keeps it current with pushes after that (src/lib/notify/apns.ts).
 */
import { Platform } from "react-native";
import type { MMatch } from "@core";
import { api } from "../api/client";

export function lockScreenSupported(): boolean {
  return Platform.OS === "ios" && Number(String(Platform.Version).split(".")[0]) >= 17;
}

function props(m: MMatch, labels: { a: string; b: string; court: string }) {
  const s = m.score;
  return {
    a: labels.a,
    b: labels.b,
    sets: [...(s?.sets ?? []).map((x) => `${x.a}-${x.b}`), ...(s?.games ? [`${s.games.a}-${s.games.b}`] : [])].join(" "),
    points: s?.points ? `${s.points.a}-${s.points.b}` : "",
    serving: s?.serving ?? null,
    status: m.status === "paused" ? "Paused" : "Live",
    court: labels.court,
  };
}

export async function startLockScreen(m: MMatch, labels: { a: string; b: string; court: string }) {
  if (!lockScreenSupported()) return;
  // Loaded lazily: the widget module exists only in the iOS build.
  const Activity = (await import("./MatchScoreActivity")).default;
  for (const existing of Activity.getInstances()) await existing.end("immediate");
  const instance = Activity.start(props(m, labels), `movescore://match/${m.id}`);
  const send = (token: string | null) => token && api("/api/mobile/v1/live-activities", { who: "me", body: { matchId: m.id, pushToken: token } }).catch(() => {});
  void instance.getPushToken().then(send);
  instance.addPushTokenListener((e: { pushToken: string }) => void send(e.pushToken));
}

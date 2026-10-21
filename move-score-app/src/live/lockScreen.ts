/**
 * iPhone lock-screen cards (Live Activities), one per match. The app starts one
 * from the match screen; the server can also start one by push (iOS 17.2+) when
 * a player's match is next, called to court or live, and keeps every card current
 * with pushes after that (src/lib/notify/apns.ts).
 *
 * - One card per match: starting a match's card updates the one already showing
 *   it and never ends another match's card. Which card is which match is kept on
 *   the phone (`ms.liveActivities`: match id → activity id), because expo-widgets
 *   does not hand JavaScript a card's link.
 * - Every card's update token goes to POST /live-activities with its match.
 *   Cards started by push get theirs through the `onExpoWidgetsActivityPushTokenReceived`
 *   event added by patches/expo-widgets+57.0.22.patch (Activity.activityUpdates),
 *   which also carries the card's link, so the match is known.
 * - The phone's push-to-start token goes to POST /me/live-activity/start-token.
 *
 * Nothing here logs a token.
 */
import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo";
import { liveState, matchIdFromUrl, matchUrl, type MMatch } from "@core";
import { api } from "../api/client";
import { session } from "../state/session";
import { getJson, setJson } from "../state/kv";
import { config } from "../config";
import { lockLabels } from "./labels";

const MAP = "ms.liveActivities";
const PUSH_STARTED_EVENT = "onExpoWidgetsActivityPushTokenReceived";

function iosVersion(): [number, number] {
  if (Platform.OS !== "ios") return [0, 0];
  const [major, minor] = String(Platform.Version).split(".").map((n) => Number(n) || 0);
  return [major ?? 0, minor ?? 0];
}

/** This build has the widget extension and the phone runs iOS 17+. */
export function lockScreenSupported(): boolean {
  return config.liveActivities && iosVersion()[0] >= 17;
}

/** Cards started by push: iOS 17.2+. */
function pushToStartSupported(): boolean {
  const [major, minor] = iosVersion();
  return lockScreenSupported() && (major > 17 || (major === 17 && minor >= 2));
}

type Factory = (typeof import("./MatchScoreActivity"))["default"];
type Instance = ReturnType<Factory["start"]>;

let factory: Promise<Factory> | null = null;
/**
 * Loaded lazily (the module exists only in the iOS build). Loading it also stores
 * the card's layout in the App Group, which a card started by push needs to draw:
 * so it is loaded at every launch (watchLiveActivities), not only on first use.
 */
function activities(): Promise<Factory> {
  factory ??= import("./MatchScoreActivity").then((m) => m.default);
  return factory;
}

function readMap(): Record<string, string> {
  const m = getJson<Record<string, string> | null>(MAP, null);
  return m && typeof m === "object" ? m : {};
}

/** Keeps only cards that still exist. */
function saveMap(map: Record<string, string>, liveIds: Set<string>) {
  const kept: Record<string, string> = {};
  for (const [matchId, activityId] of Object.entries(map)) if (liveIds.has(activityId)) kept[matchId] = activityId;
  setJson(MAP, kept);
}

/** Resolves once this phone has an install token (personal calls need it). */
function registered(): Promise<void> {
  if (session.get().installToken) return Promise.resolve();
  return new Promise((resolve) => {
    const off = session.subscribe(() => {
      if (!session.get().installToken) return;
      off();
      resolve();
    });
  });
}

const sentTokens = new Set<string>();
function sendUpdateToken(matchId: string, token: string | null | undefined) {
  if (!token || sentTokens.has(`${matchId}:${token}`)) return;
  sentTokens.add(`${matchId}:${token}`);
  void registered()
    .then(() => api("/api/mobile/v1/live-activities", { who: "me", body: { matchId, pushToken: token } }))
    .catch(() => sentTokens.delete(`${matchId}:${token}`));
}

let sentStartToken: string | null = null;
function sendStartToken(token: string | null | undefined) {
  if (!token || token === sentStartToken) return;
  sentStartToken = token;
  void registered()
    .then(() => api("/api/mobile/v1/me/live-activity/start-token", { who: "me", body: { token } }))
    .catch(() => {
      if (sentStartToken === token) sentStartToken = null;
    });
}

const following = new Set<string>();
/** Sends this card's update token now and whenever iOS rotates it. */
function follow(instance: Instance, matchId: string) {
  const id = instance.getId();
  if (following.has(id)) return;
  following.add(id);
  void instance
    .getPushToken()
    .then((t) => sendUpdateToken(matchId, t))
    .catch(() => {});
  instance.addPushTokenListener((e) => sendUpdateToken(matchId, e.pushToken));
}

function cardProps(m: MMatch, labels: { a: string; b: string; court: string }) {
  // `status` stays the server's English word (the card maps it); the card's own words ride along.
  return { ...liveState(m.score, { ...labels, status: m.status === "paused" ? "Paused" : "Live" }, { matchId: m.id }), labels: lockLabels() };
}

/** Shows this match on the lock screen: updates its card if there is one, otherwise starts one. Other matches' cards stay. */
export async function startLockScreen(m: MMatch, labels: { a: string; b: string; court: string }) {
  if (!lockScreenSupported()) return;
  const Activity = await activities();
  const map = readMap();
  const live = Activity.getInstances();
  const props = cardProps(m, labels);
  const existing = live.find((i) => i.getId() === map[m.id]);
  if (existing) {
    await existing.update(props).catch(() => {});
    follow(existing, m.id);
    return;
  }
  const instance = Activity.start(props, matchUrl(m.id));
  map[m.id] = instance.getId();
  saveMap(map, new Set([...live.map((i) => i.getId()), instance.getId()]));
  follow(instance, m.id);
}

/** Ends this match's card now (other cards stay). */
export async function endLockScreen(matchId: string) {
  if (!lockScreenSupported()) return;
  const Activity = await activities();
  const map = readMap();
  const live = Activity.getInstances();
  const card = live.find((i) => i.getId() === map[matchId]);
  if (card) await card.end("immediate").catch(() => {});
  delete map[matchId];
  saveMap(map, new Set(live.map((i) => i.getId())));
}

let watching = false;
/**
 * At launch (iOS): loads the card layout into the App Group, picks up the update
 * tokens of cards already on the lock screen (including ones started by push
 * while the app was not running), and registers the push-to-start token.
 */
export async function watchLiveActivities(): Promise<void> {
  if (watching || !lockScreenSupported()) return;
  watching = true;
  try {
    const Activity = await activities();
    const map = readMap();
    const live = Activity.getInstances();
    for (const instance of live) {
      const matchId = Object.keys(map).find((k) => map[k] === instance.getId());
      if (matchId) follow(instance, matchId);
    }
    saveMap(map, new Set(live.map((i) => i.getId())));

    // Cards started by push (patched expo-widgets): the event carries the card's link.
    const native = requireOptionalNativeModule<{
      addListener(event: string, fn: (e: { activityId: string; pushToken: string; url?: string | null }) => void): { remove(): void };
    }>("ExpoWidgets");
    native?.addListener(PUSH_STARTED_EVENT, (e) => {
      const matchId = matchIdFromUrl(e.url);
      if (!matchId || !e.pushToken) return;
      const m = readMap();
      m[matchId] = e.activityId;
      setJson(MAP, m);
      sendUpdateToken(matchId, e.pushToken);
    });

    if (pushToStartSupported()) {
      const { addPushToStartTokenListener } = await import("expo-widgets");
      addPushToStartTokenListener((e) => sendStartToken(e.activityPushToStartToken));
    }
  } catch {
    // No widget extension in this build, or Live Activities switched off in Settings.
    watching = false;
  }
}

/**
 * Registers the phone with the server (works without signing in) and, once the
 * person agrees, with the push service. Tapping an alert opens what it is about.
 *
 * The Account switch ("Alerts on this phone") is the store `alerts`, run by the
 * pure reducer in src/lib/mobile/alertsSwitch.ts: it shows the person's choice at
 * once, saves it on the phone, and only goes back off with a reason the screen
 * shows. Registrations run one at a time, so a late answer never overrides a
 * newer tap; the phone registers again when the app returns to the foreground.
 */
import { AppState, Platform, type AppStateStatus } from "react-native";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { router } from "expo-router";
import { ALERTS_OFF, alertsPermission, alertsReducer, registrationOutcome, type AlertsAction, type AlertsPermission, type AlertsState } from "@core";
import { api, ApiError, onInstallRejected } from "../api/client";
import { session, resetInstallation, saveInstallToken } from "../state/session";
import { appVersion } from "../config";
import { syncFollows } from "../state/follows";
import { createStore } from "../state/store";
import { getJson, setJson } from "../state/kv";
import { report } from "../monitoring";
import { flushPrefs } from "./prefs";

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldPlaySound: true, shouldSetBadge: false, shouldShowBanner: true, shouldShowList: true }),
});

/** Logs why alerts could not be set up (console for a device log, Sentry when configured). */
function logAlerts(what: string, e: unknown, quiet = false) {
  console.warn(`[alerts] ${what}:`, e instanceof Error ? `${e.name}: ${e.message}` : e);
  if (!quiet) report(e instanceof Error ? e : new Error(`${what}: ${String(e)}`), { where: "alerts", what });
}

/* ---------- the switch ---------- */

const WANT = "ms.alerts.on";
export const alerts = createStore<AlertsState>(ALERTS_OFF);

function dispatch(a: AlertsAction) {
  const before = alerts.get();
  const next = alertsReducer(before, a);
  if (next === before) return;
  alerts.set(next);
  if (next.want !== before.want || a.type === "load") setJson(WANT, next.want);
}

const supported = () => Platform.OS !== "web" && Device.isDevice;

async function readPermission(): Promise<AlertsPermission> {
  if (!supported()) return "undetermined";
  try {
    return alertsPermission(await Notifications.getPermissionsAsync());
  } catch (e) {
    logAlerts("reading notification permission failed", e);
    return "undetermined";
  }
}

let loading: Promise<void> | null = null;
let loaded = false;
/** The saved choice, checked against what the phone allows now. Once per launch. */
function ensureLoaded(): Promise<void> {
  loading ??= (async () => {
    const permission = await readPermission();
    dispatch({ type: "load", stored: getJson<boolean | null>(WANT, null), permission });
    loaded = true;
    watchForeground();
  })();
  return loading;
}

/* ---------- push token ---------- */

// Android 8+ shows nothing without a channel, and Android 13 only offers the
// notification prompt once one exists: create them before asking or fetching a token.
async function channels() {
  if (Platform.OS !== "android") return;
  try {
    await Notifications.setNotificationChannelAsync("matches", { name: "Matches you follow", importance: Notifications.AndroidImportance.HIGH, lightColor: "#FCFC00" });
    await Notifications.setNotificationChannelAsync("announcements", { name: "Tournament announcements", importance: Notifications.AndroidImportance.DEFAULT });
  } catch (e) {
    logAlerts("creating the Android notification channels failed", e);
  }
}

const NETWORKISH = /network|offline|internet|timed? ?out|connection|unreachable|SERVICE_NOT_AVAILABLE/i;

async function pushToken(ask: boolean): Promise<{ permission: AlertsPermission; token: string | null; online: boolean | null }> {
  await channels();
  let permission = await readPermission();
  if (permission !== "allowed" && ask) {
    try {
      permission = alertsPermission(await Notifications.requestPermissionsAsync());
    } catch (e) {
      logAlerts("asking for notification permission failed", e);
    }
  }
  if (permission !== "allowed") return { permission, token: null, online: null };
  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId) {
    logAlerts("no EAS projectId in this build", new Error("extra.eas.projectId is missing"));
    return { permission, token: null, online: null };
  }
  try {
    return { permission, token: (await Notifications.getExpoPushTokenAsync({ projectId })).data, online: true };
  } catch (e) {
    // On Android this is typically "Default FirebaseApp is not initialized" (no google-services.json
    // in the build); on iOS, a missing aps-environment entitlement or no network.
    const offline = e instanceof Error && NETWORKISH.test(e.message);
    logAlerts("getting the Expo push token failed", e, offline);
    return { permission, token: null, online: offline ? false : null };
  }
}

/* ---------- registration ---------- */

const register = (installationId: string, expoPushToken: string | null, alertsOn: boolean) =>
  api<{ installToken: string; tokenAccepted?: boolean | null }>("/api/mobile/v1/devices", {
    who: "me",
    body: {
      installationId,
      platform: Platform.OS === "android" ? "android" : "ios",
      expoPushToken,
      // Switched off here: the server forgets this phone's push token.
      alerts: alertsOn,
      appVersion,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
    },
  });

async function attempt(): Promise<{ alerts: boolean }> {
  if (!session.get().installationId) return { alerts: false };
  await ensureLoaded();
  dispatch({ type: "permission", permission: await readPermission() });
  const start = alerts.get();
  const here = supported();
  let permission: AlertsPermission = "undetermined";
  let token: string | null = null;
  let online: boolean | null = null;
  // Only a tap (or coming back from Settings) shows the system prompt; launches never do.
  if (start.want && here) ({ permission, token, online } = await pushToken(start.status === "turning-on"));

  let serverStatus: number | null = null;
  let tokenAccepted: boolean | undefined;
  let r: { installToken: string; tokenAccepted?: boolean | null } | null = null;
  try {
    try {
      r = await register(session.get().installationId!, token, start.want);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409)) throw e;
      await resetInstallation();
      r = await register(session.get().installationId!, token, start.want);
    }
    serverStatus = 200;
    tokenAccepted = r.tokenAccepted ?? undefined;
  } catch (e) {
    serverStatus = e instanceof ApiError ? e.status : 0;
    // No response at all is the ordinary offline case: console only.
    logAlerts(`registering this phone failed (${serverStatus || "no response"})`, e, serverStatus === 0);
  }
  if (r) {
    await saveInstallToken(r.installToken);
    await syncFollows();
    void flushPrefs();
  }
  if (tokenAccepted === false) logAlerts("the server refused this phone's push token", new Error(`token prefix ${token?.slice(0, 18)}`));

  // A result for a switch turned off meanwhile is ignored by the reducer.
  if (start.want) dispatch({ type: "result", outcome: registrationOutcome({ supported: here, permission, token, online, serverStatus, tokenAccepted }) });
  const s = alerts.get();
  return { alerts: s.want && s.status === "on" };
}

let chain: Promise<unknown> = Promise.resolve();
function enqueue(): Promise<{ alerts: boolean }> {
  const p = chain.then(attempt).catch((e: unknown) => {
    logAlerts("registration crashed", e);
    dispatch({ type: "result", outcome: "failed" });
    return { alerts: false };
  });
  chain = p;
  return p;
}

/**
 * Called at launch (without asking), when the person turns alerts on (asking),
 * and on signing in or out (so alerts follow the account). The server answers 409
 * when it will not vouch for this id — taken, or this phone's token is from an
 * older build — and the phone then starts over as a new installation.
 */
export function registerDevice(askForAlerts = false): Promise<{ alerts: boolean }> {
  // The switch moves now (synchronously, so it never snaps back), not when the server answers.
  if (askForAlerts && loaded) dispatch({ type: "toggle", on: true });
  return ensureLoaded().then(() => {
    if (askForAlerts && alerts.get().status !== "turning-on") dispatch({ type: "toggle", on: true });
    return enqueue();
  });
}

/** The Account switch turned on (also "Try again"). */
export const turnAlertsOn = () => registerDevice(true);

/** The Account switch turned off: no more alerts to this phone. */
export function turnAlertsOff(): Promise<{ alerts: boolean }> {
  dispatch({ type: "toggle", on: false });
  return ensureLoaded().then(() => {
    dispatch({ type: "toggle", on: false });
    return enqueue();
  });
}

/** The Account screen opening: the saved choice, checked against the phone's setting now. */
export async function refreshAlerts(): Promise<void> {
  await ensureLoaded();
  await onForeground();
}

async function onForeground() {
  const before = alerts.get();
  dispatch({ type: "permission", permission: await readPermission() });
  const after = alerts.get();
  // Back from Settings, still waiting to register, or allowed/blocked in Settings meanwhile: register again.
  if (after.status === "turning-on" || after.status === "waiting" || after.want !== before.want) void enqueue();
  else void flushPrefs();
}

let watching = false;
function watchForeground() {
  if (watching || Platform.OS === "web") return;
  watching = true;
  let last: AppStateStatus = AppState.currentState;
  AppState.addEventListener("change", (next) => {
    const was = last;
    last = next;
    // Only a real return (from Settings or another app), not the system prompt's brief "inactive".
    if (next === "active" && was === "background") void onForeground();
  });
}

// A personal call refused for want of a valid install token: register again.
onInstallRejected(() => registerDevice(false).then(() => undefined));

/** Whether the phone itself lets Move Score show alerts (iOS provisional counts). */
export async function alertsAllowed(): Promise<boolean> {
  return (await readPermission()) === "allowed";
}

/**
 * movescore://match/<id>, tie/<id>, t/<slug>, nation/<code>[?slug=], player/<id>?slug=, pass → the screen.
 * (Opened from outside, the same links are handled by Expo Router's file routes.)
 */
export function openLink(url: string | undefined) {
  if (!url) return;
  const m = /^movescore:\/\/(match|tie|t|pass|discover|nation|player)\/?([^/?#]*)(?:\?([^#]*))?/.exec(url);
  if (!m) return;
  const [, kind, id, query] = m;
  // No URLSearchParams: React Native's is incomplete.
  const q = /(?:^|&)slug=([^&]*)/.exec(query ?? "");
  const slug = q?.[1] ? decodeURIComponent(q[1]) : undefined;
  if (kind === "match" && id) router.push({ pathname: "/match/[id]", params: { id } });
  else if (kind === "tie" && id) router.push({ pathname: "/tie/[id]", params: { id } });
  else if (kind === "t" && id) router.push({ pathname: "/t/[slug]", params: { slug: id } });
  else if (kind === "nation" && id) router.push({ pathname: "/nation/[code]", params: slug ? { code: id, slug } : { code: id } });
  else if (kind === "player" && id && slug) router.push({ pathname: "/player/[id]", params: { id, slug } });
  else if (kind === "pass") router.push("/pass");
  else router.push("/");
}

export function listenForTaps(): () => void {
  if (Platform.OS === "web") return () => {};
  const sub = Notifications.addNotificationResponseReceivedListener((r) => openLink(r.notification.request.content.data?.url as string | undefined));
  void Notifications.getLastNotificationResponseAsync().then((r) => r && openLink(r.notification.request.content.data?.url as string | undefined));
  return () => sub.remove();
}

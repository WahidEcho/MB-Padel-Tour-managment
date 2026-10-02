/**
 * Registers the phone with the server (works without signing in) and, once the
 * person agrees, with the push service. Tapping an alert opens what it is about.
 */
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { router } from "expo-router";
import { api, ApiError, onInstallRejected } from "../api/client";
import { session, resetInstallation, saveInstallToken } from "../state/session";
import { appVersion } from "../config";
import { syncFollows } from "../state/follows";

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldPlaySound: true, shouldSetBadge: false, shouldShowBanner: true, shouldShowList: true }),
});

async function channels() {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync("matches", { name: "Matches you follow", importance: Notifications.AndroidImportance.HIGH, lightColor: "#FCFC00" });
  await Notifications.setNotificationChannelAsync("announcements", { name: "Tournament announcements", importance: Notifications.AndroidImportance.DEFAULT });
}

async function pushToken(ask: boolean): Promise<string | null> {
  if (Platform.OS === "web" || !Device.isDevice) return null;
  await channels();
  const current = await Notifications.getPermissionsAsync();
  let status = current.status;
  if (status !== "granted" && ask) status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== "granted") return null;
  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId) return null;
  try {
    return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  } catch {
    return null;
  }
}

const register = (installationId: string, expoPushToken: string | null) =>
  api<{ installToken: string }>("/api/mobile/v1/devices", {
    who: "me",
    body: {
      installationId,
      platform: Platform.OS === "android" ? "android" : "ios",
      expoPushToken,
      appVersion,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
    },
  });

/**
 * Called at launch (without asking), when the person turns alerts on (asking),
 * and on signing in or out (so alerts follow the account). The server answers 409
 * when it will not vouch for this id — taken, or this phone's token is from an
 * older build — and the phone then starts over as a new installation.
 */
export async function registerDevice(askForAlerts = false): Promise<{ alerts: boolean }> {
  if (!session.get().installationId) return { alerts: false };
  const token = await pushToken(askForAlerts);
  try {
    let r: { installToken: string };
    try {
      r = await register(session.get().installationId!, token);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409)) throw e;
      await resetInstallation();
      r = await register(session.get().installationId!, token);
    }
    await saveInstallToken(r.installToken);
    await syncFollows();
  } catch {
    /* offline at launch: retried next time */
  }
  return { alerts: Boolean(token) };
}

// A personal call refused for want of a valid install token: register again.
onInstallRejected(() => registerDevice(false).then(() => undefined));

export async function alertsAllowed(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  return (await Notifications.getPermissionsAsync()).status === "granted";
}

/** movescore://match/<id>, movescore://tie/<id>, movescore://t/<id or slug> → the screen. */
export function openLink(url: string | undefined) {
  if (!url) return;
  const m = /^movescore:\/\/(match|tie|t|pass|discover)\/?([^/?#]*)/.exec(url);
  if (!m) return;
  const [, kind, id] = m;
  if (kind === "match" && id) router.push({ pathname: "/match/[id]", params: { id } });
  else if (kind === "tie" && id) router.push({ pathname: "/tie/[id]", params: { id } });
  else if (kind === "t" && id) router.push({ pathname: "/t/[slug]", params: { slug: id } });
  else if (kind === "pass") router.push("/pass");
  else router.push("/");
}

export function listenForTaps(): () => void {
  if (Platform.OS === "web") return () => {};
  const sub = Notifications.addNotificationResponseReceivedListener((r) => openLink(r.notification.request.content.data?.url as string | undefined));
  void Notifications.getLastNotificationResponseAsync().then((r) => r && openLink(r.notification.request.content.data?.url as string | undefined));
  return () => sub.remove();
}

/**
 * Keeps the My matches widget current. The rows come ready-made from
 * GET /api/mobile/v1/me/widget; the widget extension reads them from the App
 * Group (expo-widgets writes the timeline there).
 *
 * Refreshed at launch, on every return to the foreground, when someone signs in
 * or out, and whenever an alert arrives while the app runs
 * (addNotificationReceivedListener): an alert usually means a match changed.
 * With the app in the background, iOS redraws the widget at each start time
 * from the timeline (timeline.ts); a background refresh by silent push would
 * need expo-task-manager, which this build does not have.
 */
import { AppState, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import type { MWidget } from "@core";
import { api } from "../api/client";
import { session } from "../state/session";
import { config } from "../config";
import { widgetTimeline } from "./timeline";
import { lockLabels } from "./labels";
import { onLangChange } from "../i18n/t";

/** At most one refresh this often, unless an alert asks for one. */
const MIN_GAP_MS = 60_000;

export function widgetsSupported(): boolean {
  return config.widgets && Platform.OS === "ios";
}

let last = 0;
let inFlight: Promise<void> | null = null;

export function refreshWidget(force = false): Promise<void> {
  if (!widgetsSupported() || !session.get().installToken) return Promise.resolve();
  if (!force && Date.now() - last < MIN_GAP_MS) return Promise.resolve();
  inFlight ??= (async () => {
    try {
      const w = await api<MWidget>("/api/mobile/v1/me/widget", { who: "me" });
      const MyMatches = (await import("./MyMatchesWidget")).default;
      // The widget's words in the app's language ride along with the rows.
      const labels = lockLabels();
      MyMatches.updateTimeline(widgetTimeline(w, Date.now()).map((e) => ({ ...e, props: { ...e.props, labels } })));
      last = Date.now();
    } catch {
      // Offline or no widget extension in this build: the widget keeps its last rows.
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

let watching = false;
export function watchWidget(): void {
  if (watching || !widgetsSupported()) return;
  watching = true;
  void refreshWidget(true);
  AppState.addEventListener("change", (s) => {
    if (s === "active") void refreshWidget();
  });
  let user = session.get().user?.id ?? null;
  let install = session.get().installToken;
  session.subscribe(() => {
    const s = session.get();
    if ((s.user?.id ?? null) === user && s.installToken === install) return;
    user = s.user?.id ?? null;
    install = s.installToken;
    void refreshWidget(true);
  });
  // A new language on Account: redraw the widget in it.
  onLangChange(() => void refreshWidget(true));
  // A short wait lets the server finish what the alert is about before we read it.
  Notifications.addNotificationReceivedListener(() => {
    setTimeout(() => void refreshWidget(true), 1500);
  });
}

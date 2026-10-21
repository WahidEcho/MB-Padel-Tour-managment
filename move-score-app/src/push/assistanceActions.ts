/**
 * Coming / Decline on a master referee's call-for-assistance alert (migration 0042): the
 * notification category `assistance_call` (the server sends the time-sensitive alert and
 * its reminders with `categoryId: "assistance_call"`). Coming opens the app on the master
 * desk and answers; Decline answers without opening the app where the phone allows. Both
 * post `{ action: "respond", callId, answer }` with the master's own staff token (signed in
 * on this phone). A tap on the alert itself still opens the master desk on that call.
 * Builds without the category (Move Score 1.0.1) show the alert without buttons.
 */
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { api } from "../api/client";
import { session } from "../state/session";
import { ct } from "../referee/callText";

export const ASSISTANCE_CATEGORY = "assistance_call";
const COMING = "assistance_coming";
const DECLINE = "assistance_decline";

let registered = false;
/** Registers the category's two buttons, in the phone's language. Safe to call more than once. */
export async function registerAssistanceCategory(): Promise<void> {
  if (registered || Platform.OS === "web") return;
  registered = true;
  try {
    await Notifications.setNotificationCategoryAsync(ASSISTANCE_CATEGORY, [
      { identifier: COMING, buttonTitle: ct("coming"), options: { opensAppToForeground: true } },
      { identifier: DECLINE, buttonTitle: ct("decline"), options: { opensAppToForeground: false, isDestructive: true } },
    ]);
  } catch {
    registered = false;
  }
}

/** The session read from storage (a cold start from the button). */
function sessionReady(): Promise<void> {
  if (session.get().ready) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = session.subscribe(() => {
      if (session.get().ready) {
        stop?.();
        resolve();
      }
    });
    setTimeout(resolve, 5_000);
  });
}

/**
 * A response to a call alert: a button (answered here) or a tap (the master desk on that
 * call). Returns false when the alert is not a call for assistance.
 */
export function handleAssistanceResponse(r: Notifications.NotificationResponse): boolean {
  const data = (r.notification.request.content.data ?? {}) as { kind?: unknown; callId?: unknown };
  if (data.kind !== "assistance" && data.kind !== "assistance_going") return false;
  const callId = typeof data.callId === "string" ? data.callId : null;
  const answer = r.actionIdentifier === COMING ? "coming" : r.actionIdentifier === DECLINE ? "declined" : null;
  if (answer && callId) {
    void (async () => {
      await sessionReady();
      if (!session.get().staff) return;
      try {
        await api("/api/mobile/v1/referee/assistance", { who: "staff", body: { action: "respond", callId, answer } });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      } catch {
        /* the desk shows the call and its buttons: answered there */
      }
    })();
  }
  if (answer !== "declined") router.push(callId ? { pathname: "/referee/master", params: { call: callId } } : "/referee/master");
  return true;
}

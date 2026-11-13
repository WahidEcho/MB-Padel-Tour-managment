/**
 * A player's call to court, answered from the phone that rang (owner, 12 Nov 2026): the server
 * sends a player's own "called to court" alert (and its reminder) with the Move Score ringtone and
 * the notification category `player_call`, whose two buttons answer without opening the app
 * (Decline) or open the match (I'm coming). Both post to /me/matches/:id/call-answer with the
 * signed-in account; the chair umpire's call card shows the answer.
 */
import { Platform } from "react-native";
import { router } from "expo-router";
import * as Notifications from "expo-notifications";
import * as Haptics from "expo-haptics";
import { api } from "../api/client";
import { session } from "../state/session";
import { queryClient } from "../api/queries";
import { tr } from "../i18n/t";

export const PLAYER_CALL_CATEGORY = "player_call";
const COMING = "player_call_coming";
const DECLINE = "player_call_decline";
const KINDS = new Set(["called_to_court", "call_reminder", "call_ring"]);

let registered = false;
/** Registers the category's two buttons, in the app's language. Safe to call more than once. */
export async function registerPlayerCallCategory(): Promise<void> {
  if (registered || Platform.OS === "web") return;
  registered = true;
  try {
    await Notifications.setNotificationCategoryAsync(PLAYER_CALL_CATEGORY, [
      { identifier: COMING, buttonTitle: tr("player.callComing"), options: { opensAppToForeground: true } },
      { identifier: DECLINE, buttonTitle: tr("player.callDecline"), options: { opensAppToForeground: false, isDestructive: true } },
    ]);
  } catch {
    registered = false;
  }
}

/** movescore://match/<id> → the match id. */
export function matchIdOf(url: unknown): string | null {
  const m = typeof url === "string" ? /^movescore:\/\/match\/([0-9a-f-]{36})/i.exec(url) : null;
  return m ? m[1] : null;
}

/** Sends the player's answer. Resolves false when it could not be sent. */
export async function answerCall(matchId: string, answer: "coming" | "declined"): Promise<boolean> {
  try {
    await api(`/api/mobile/v1/me/matches/${matchId}/call-answer`, { who: "me", method: "POST", body: { answer } });
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    return true;
  } catch {
    return false;
  } finally {
    void queryClient.invalidateQueries({ queryKey: ["my-calls"] });
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

/** A button on a player's call alert. Returns false when the response is not one. */
export function handlePlayerCallResponse(r: Notifications.NotificationResponse): boolean {
  const data = (r.notification.request.content.data ?? {}) as { kind?: unknown; url?: unknown };
  if (typeof data.kind !== "string" || !KINDS.has(data.kind)) return false;
  const answer = r.actionIdentifier === COMING ? "coming" : r.actionIdentifier === DECLINE ? "declined" : null;
  const matchId = matchIdOf(data.url);
  if (!answer || !matchId) return false;
  void (async () => {
    await sessionReady();
    if (!session.get().user) return;
    await answerCall(matchId, answer);
  })();
  if (answer === "coming") router.push({ pathname: "/match/[id]", params: { id: matchId } });
  return true;
}

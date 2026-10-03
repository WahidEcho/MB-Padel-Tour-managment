/**
 * Which kinds of alert this phone gets (set or moved, starting soon, results...).
 * Kept on the phone first, so a tap sticks: the server's copy never overwrites
 * a change still waiting to be sent, and a change that could not be saved (offline,
 * or before this phone is registered) is sent again after the next registration
 * or when the app comes back to the foreground.
 */
import { DEFAULT_ALERT_PREFS, prefsDirty, prefsFromServer, prefsSaved, setAlertPref, type AlertPrefsState, type MAlertPrefs } from "@core";
import { api } from "../api/client";
import { session } from "../state/session";
import { createStore } from "../state/store";
import { getJson, setJson } from "../state/kv";

const KEY = "ms.alertPrefs";
const saved = getJson<Partial<AlertPrefsState> | null>(KEY, null);
export const alertPrefs = createStore<AlertPrefsState>({
  prefs: { ...DEFAULT_ALERT_PREFS, ...(saved?.prefs ?? {}) },
  version: saved?.version ?? 0,
  sent: saved?.sent ?? 0,
});
alertPrefs.subscribe(() => setJson(KEY, alertPrefs.get()));

/** One alert type switched on or off on the Account screen. */
export function changeAlertPref(key: keyof MAlertPrefs, on: boolean) {
  alertPrefs.set((s) => setAlertPref(s, key, on));
  void flushPrefs();
}

let flushing: Promise<void> | null = null;
/** Sends unsent changes, one save at a time, until none are left or the server cannot be reached. */
export function flushPrefs(): Promise<void> {
  flushing ??= (async () => {
    try {
      while (prefsDirty(alertPrefs.get()) && session.get().installToken) {
        const s = alertPrefs.get();
        try {
          await api("/api/mobile/v1/me/prefs", { method: "PATCH", who: "me", body: s.prefs });
          alertPrefs.set((x) => prefsSaved(x, s.version));
        } catch (e) {
          console.warn("[alerts] saving alert types failed; kept on the phone and sent again later:", e instanceof Error ? e.message : e);
          return;
        }
      }
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

/** The server's copy, taken unless a change made here is still waiting to be sent. */
export async function refreshPrefs(): Promise<void> {
  if (!session.get().installToken) return;
  try {
    const r = await api<{ prefs: MAlertPrefs }>("/api/mobile/v1/me/prefs", { who: "me" });
    alertPrefs.set((s) => prefsFromServer(s, { ...DEFAULT_ALERT_PREFS, ...r.prefs }));
  } catch {
    /* offline: the phone's copy stands */
  }
  await flushPrefs();
}

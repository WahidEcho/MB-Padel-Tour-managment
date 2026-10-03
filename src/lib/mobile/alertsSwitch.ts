/**
 * The Move Score app's "Alerts on this phone" switch and alert-type toggles, as
 * pure state. The switch follows the person's choice the moment they tap it and
 * only goes back off with a reason the screen shows (notifications blocked in
 * the phone's Settings, or this phone could not be registered). A server that
 * cannot be reached keeps it on; the phone registers again when it comes back to
 * the foreground. Shared with the app through move-score-app/src/core.
 */
import type { MAlertPrefs } from "./contract";

/** What the operating system lets the app do with notifications. */
export type AlertsPermission = "allowed" | "denied" | "undetermined";

/**
 * expo-notifications reports iOS provisional and ephemeral authorisation as
 * "undetermined"; both deliver alerts, so they count as allowed here.
 * iOS raw statuses: 0 not determined, 1 denied, 2 authorized, 3 provisional, 4 ephemeral.
 */
export function alertsPermission(p: { status?: string | null; granted?: boolean | null; ios?: { status?: number | null } | null } | null | undefined): AlertsPermission {
  if (!p) return "undetermined";
  const ios = p.ios?.status;
  if (p.status === "granted" || p.granted === true || ios === 2 || ios === 3 || ios === 4) return "allowed";
  if (p.status === "denied" || ios === 1) return "denied";
  return "undetermined";
}

/** How one attempt to register this phone for alerts ended. */
export type AlertsOutcome =
  | "ok" // the server has this phone's push token
  | "offline" // the server (or the push service) could not be reached: keep on, try again later
  | "blocked" // notifications are off for the app in the phone's Settings
  | "failed" // no push token from the phone, or the server refused it
  | "unsupported"; // no push here (web preview, simulator)

/**
 * Pure classification of one registration attempt.
 * `serverStatus`: HTTP status of the device registration (0 = no response), null when not sent.
 * `tokenAccepted`: the server's word on the token it was sent (undefined from an older server).
 */
export function registrationOutcome(i: {
  supported: boolean;
  permission: AlertsPermission;
  token: string | null;
  online?: boolean | null;
  serverStatus?: number | null;
  tokenAccepted?: boolean;
}): AlertsOutcome {
  if (!i.supported) return "unsupported";
  if (i.permission !== "allowed") return "blocked";
  // Fetching an Expo push token is itself a network call: offline, it fails for that reason alone.
  if (!i.token) return i.online === false ? "offline" : "failed";
  const s = i.serverStatus;
  if (s == null || s === 0 || s === 408 || s === 429 || s >= 500) return "offline";
  if (s >= 400) return "failed";
  return i.tokenAccepted === false ? "failed" : "ok";
}

export type AlertsReason = "settings" | "register" | "unsupported";
export type AlertsStatus = "off" | "turning-on" | "on" | "waiting";

/** `want` is what the switch shows and what is saved on the phone. */
export interface AlertsState {
  want: boolean;
  status: AlertsStatus;
  reason: AlertsReason | null;
}

export type AlertsAction =
  | { type: "load"; stored: boolean | null; permission: AlertsPermission }
  | { type: "toggle"; on: boolean }
  | { type: "result"; outcome: AlertsOutcome }
  | { type: "permission"; permission: AlertsPermission };

export const ALERTS_OFF: AlertsState = { want: false, status: "off", reason: null };

const off = (reason: AlertsReason | null): AlertsState => ({ want: false, status: "off", reason });

/**
 * The switch's state machine. Invariant: `want` is false exactly when `status` is "off".
 * - A tap turns it on or off at once.
 * - An attempt the person started ("turning-on") that fails goes back off with its reason.
 * - A background attempt (launch, foreground, sign-in) never switches it off over a hiccup:
 *   it waits and tries again; only notifications blocked in Settings turn it off.
 * - A result that arrives after the person turned it off is ignored.
 */
export function alertsReducer(s: AlertsState, a: AlertsAction): AlertsState {
  switch (a.type) {
    case "load": {
      // An install from before the switch was saved: alerts were on whenever the phone allowed them.
      const want = a.stored ?? a.permission === "allowed";
      if (!want) return ALERTS_OFF;
      if (a.permission === "allowed") return { want: true, status: "on", reason: null };
      // Chosen on, then turned off in the phone's Settings.
      return off(a.stored === true && a.permission === "denied" ? "settings" : null);
    }
    case "toggle":
      return a.on ? { want: true, status: "turning-on", reason: null } : ALERTS_OFF;
    case "result": {
      if (!s.want) return s;
      const asked = s.status === "turning-on";
      switch (a.outcome) {
        case "ok":
          return { want: true, status: "on", reason: null };
        case "offline":
          return { want: true, status: "waiting", reason: null };
        case "blocked":
          return off("settings");
        case "unsupported":
          return off("unsupported");
        case "failed":
          return asked ? off("register") : { want: true, status: "waiting", reason: null };
      }
      return s;
    }
    case "permission": {
      // Back from Settings with notifications allowed: carry on turning on.
      if (!s.want && s.reason === "settings" && a.permission === "allowed") return { want: true, status: "turning-on", reason: null };
      // Turned off in Settings while the switch was on.
      if (s.want && a.permission === "denied") return off("settings");
      return s;
    }
  }
}

/** The line (and button) shown under the switch, if any. */
export function alertsNotice(s: AlertsState): { text: string; action: "settings" | "retry" | null } | null {
  if (s.reason === "settings") return { text: "Notifications are off for Move Score in Settings.", action: "settings" };
  if (s.reason === "register") return { text: "Couldn't register this phone for alerts. Try again.", action: "retry" };
  if (s.reason === "unsupported") return { text: "Alerts need the Move Score app on a phone.", action: null };
  if (s.status === "waiting") return { text: "Alerts are on. This phone hasn't finished registering; it tries again when you come back to Move Score.", action: "retry" };
  return null;
}

/* ---------- alert types (scheduled, starting, live, ...) ---------- */

/**
 * The alert-type toggles, kept on the phone first. `version` counts changes;
 * `sent` is the version the server last confirmed. Unsent changes are never
 * overwritten by what the server says; they are sent again later.
 */
export interface AlertPrefsState {
  prefs: MAlertPrefs;
  version: number;
  sent: number;
}

export const prefsDirty = (s: AlertPrefsState) => s.version !== s.sent;

export function setAlertPref(s: AlertPrefsState, key: keyof MAlertPrefs, on: boolean): AlertPrefsState {
  return { ...s, prefs: { ...s.prefs, [key]: on }, version: s.version + 1 };
}

/** The server's prefs, taken only when nothing changed here is still waiting to be sent. */
export function prefsFromServer(s: AlertPrefsState, server: MAlertPrefs): AlertPrefsState {
  return prefsDirty(s) ? s : { ...s, prefs: { ...server } };
}

/** The server saved the prefs sent at `version`; later taps stay unsent. */
export function prefsSaved(s: AlertPrefsState, version: number): AlertPrefsState {
  return { ...s, sent: Math.max(s.sent, version) };
}

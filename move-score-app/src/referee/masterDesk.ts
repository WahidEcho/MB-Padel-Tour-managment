/**
 * Opens the master desk (referee/master) once. A tapped call alert, "Coming" on the ringing screen and
 * "Open the master desk" all lead here; with reminders every 10 s a master taps several alerts, and each
 * used to stack another copy of the desk. When the desk is already showing, it is pointed at the call.
 */
import { router } from "expo-router";

let currentPath = "";

/** Kept current by RouteTracker in app/_layout.tsx. */
export function trackPath(path: string) {
  currentPath = path;
}

export function openMasterDesk(callId?: string | null) {
  if (currentPath === "/referee/master") {
    router.setParams(callId ? { call: callId } : {});
    return;
  }
  router.push(callId ? { pathname: "/referee/master", params: { call: callId } } : "/referee/master");
}

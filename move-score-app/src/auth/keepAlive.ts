/**
 * Keeps the signed-in person signed in. The session is refreshed silently at
 * launch, whenever the app comes back to the foreground, and shortly before the
 * access token expires, so it never goes stale while the app is open. A refresh
 * that fails for any reason other than "this session was revoked" is simply tried
 * again later (api/client.ts refreshUserSession). Only Sign out, Delete account or
 * a revoked session end it.
 *
 * For a player who signed in with their code, the account's registration status
 * is checked at the same moments, so "Complete your registration" goes away as
 * soon as the email is confirmed (even if that happened on a computer).
 */
import { AppState, type AppStateStatus } from "react-native";
import { REFRESH_AHEAD_SECONDS } from "@core";
import { refreshUserSession } from "../api/client";
import { reloadUserIfUnread, session } from "../state/session";
import { refreshAccount } from "./email";

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let retryDelay = 30_000;

function schedule(ms: number) {
  if (timer) clearTimeout(timer);
  // setTimeout caps near 24.8 days; an hour is plenty (the tick re-plans).
  timer = setTimeout(() => void tick(), Math.max(15_000, Math.min(ms, 3600_000)));
}

async function tick() {
  await reloadUserIfUnread().catch(() => undefined);
  const u = session.get().user;
  if (!u) return;
  const outcome = await refreshUserSession(REFRESH_AHEAD_SECONDS);
  const now = session.get().user;
  if (!now) return; // revoked: signed out by the refresh
  if (outcome === "failed") {
    // Offline or the server is busy: try again soon, backing off to five minutes.
    schedule(retryDelay);
    retryDelay = Math.min(retryDelay * 2, 300_000);
  } else {
    retryDelay = 30_000;
    if (now.expiresAt) schedule(now.expiresAt * 1000 - Date.now() - REFRESH_AHEAD_SECONDS * 1000);
  }
  if (now.registrationComplete === false) void refreshAccount().catch(() => undefined);
}

function onAppState(s: AppStateStatus) {
  if (s === "active") void tick();
}

/** Starts once, after the saved session is loaded. */
export function startSessionKeeper() {
  if (started) return;
  started = true;
  AppState.addEventListener("change", onAppState);
  // A new sign-in (or sign-out) re-plans the timer.
  let lastId = session.get().user?.id ?? null;
  session.subscribe(() => {
    const id = session.get().user?.id ?? null;
    if (id === lastId) return;
    lastId = id;
    if (!id && timer) clearTimeout(timer);
    else void tick();
  });
  void tick();
}

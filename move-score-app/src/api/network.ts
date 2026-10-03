/**
 * Is the phone online? React Query is told, so reads pause with no signal (no
 * failed polls every few seconds) and every paused or failed read runs again by
 * itself the moment the connection is back.
 *
 * Phones: expo-network's listener. Web: the browser's online/offline events.
 * A build made before expo-network was added has no native module for it; the
 * app then counts itself online and screens learn of a lost signal from the
 * failed request instead (ApiError status 0).
 */
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { onlineManager } from "@tanstack/react-query";

type NetworkModule = typeof import("expo-network");
type NetState = { isConnected?: boolean | null };

let Network: NetworkModule | null = null;
if (Platform.OS !== "web") {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    Network = require("expo-network") as NetworkModule;
  } catch {
    Network = null;
  }
}

/**
 * Offline only on a definite "no connection". Reachability is not used: Android
 * reports it from its own check against Google, which some venue networks block
 * while Move Score works, and a phone stuck "offline" would never fetch. A
 * connection that cannot reach the server shows up as a failed request instead.
 */
const up = (s: NetState) => s.isConnected !== false;

const browserOnline = () => typeof navigator === "undefined" || navigator.onLine !== false;

/** Wires React Query's online state to the phone's (or browser's) connection. Called once, at start. */
export function watchNetwork() {
  onlineManager.setEventListener((setOnline) => {
    if (Platform.OS === "web") {
      if (typeof window === "undefined" || !window.addEventListener) return undefined;
      const on = () => setOnline(true);
      const off = () => setOnline(false);
      setOnline(browserOnline());
      window.addEventListener("online", on);
      window.addEventListener("offline", off);
      return () => {
        window.removeEventListener("online", on);
        window.removeEventListener("offline", off);
      };
    }
    if (!Network) {
      setOnline(true);
      return undefined;
    }
    void Network.getNetworkStateAsync()
      .then((s) => setOnline(up(s)))
      .catch(() => {});
    const sub = Network.addNetworkStateListener((s) => setOnline(up(s)));
    return () => sub.remove();
  });
}

/**
 * Asks the phone again now (a listener can miss a change while the app sleeps).
 * Returns whether it is online, and tells React Query, which resumes paused reads.
 */
export async function checkNetwork(): Promise<boolean> {
  let online = true;
  if (Platform.OS === "web") online = browserOnline();
  else if (Network) {
    try {
      online = up(await Network.getNetworkStateAsync());
    } catch {
      online = onlineManager.isOnline();
    }
  }
  onlineManager.setOnline(online);
  return online;
}

/** The connection as React Query sees it, re-rendering on change. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    (cb) => onlineManager.subscribe(cb),
    () => onlineManager.isOnline(),
    () => true,
  );
}

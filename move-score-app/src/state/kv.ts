/**
 * Small persistent storage. Settings, a guest's follows and the cached last
 * feed live in SQLite's key-value store on the phone; secrets (session tokens,
 * the installation id) live in the system keychain via SecureStore. On the web
 * preview both fall back to localStorage.
 */
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

type Sync = { getItemSync(k: string): string | null; setItemSync(k: string, v: string): void; removeItemSync(k: string): void };

let store: Sync | null = null;
function kv(): Sync {
  if (store) return store;
  if (Platform.OS === "web") {
    store = {
      getItemSync: (k) => {
        try {
          return globalThis.localStorage?.getItem(k) ?? null;
        } catch {
          return null;
        }
      },
      setItemSync: (k, v) => {
        try {
          globalThis.localStorage?.setItem(k, v);
        } catch {
          /* private mode */
        }
      },
      removeItemSync: (k) => {
        try {
          globalThis.localStorage?.removeItem(k);
        } catch {
          /* ignore */
        }
      },
    };
  } else {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    store = require("expo-sqlite/kv-store").default as Sync;
  }
  return store!;
}

export function getJson<T>(key: string, fallback: T): T {
  try {
    const v = kv().getItemSync(key);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

export function setJson(key: string, value: unknown) {
  kv().setItemSync(key, JSON.stringify(value));
}

export function removeKey(key: string) {
  kv().removeItemSync(key);
}

export async function getSecret(key: string): Promise<string | null> {
  if (Platform.OS === "web") return kv().getItemSync(`secret:${key}`);
  return SecureStore.getItemAsync(key);
}

export async function setSecret(key: string, value: string | null) {
  if (Platform.OS === "web") {
    if (value == null) kv().removeItemSync(`secret:${key}`);
    else kv().setItemSync(`secret:${key}`, value);
    return;
  }
  if (value == null) await SecureStore.deleteItemAsync(key);
  else await SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK });
}

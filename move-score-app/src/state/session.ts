/**
 * Who this phone is to the server: its installation (always), a signed-in user
 * (optional: Apple, Google, email, or a player code), and a staff role (when a
 * referee code was entered).
 *
 * The user's session (access + refresh token) lives in the keychain (SecureStore)
 * and stays until the person signs out or deletes the account: see
 * src/auth/keepAlive.ts and api/client.ts for when it is refreshed and the one
 * case (the server says the refresh token is revoked) in which it is dropped.
 */
import { Platform } from "react-native";
import * as Crypto from "expo-crypto";
import { createStore } from "./store";
import { getSecret, setSecret } from "./kv";

export type UserProvider = "apple" | "google" | "email" | "player_code";

export interface Session {
  ready: boolean;
  installationId: string | null;
  installToken: string | null;
  user: {
    id: string;
    name: string | null;
    /** Shown on the account screen; absent on sessions saved before they were kept. */
    email?: string | null;
    avatarUrl?: string | null;
    provider?: UserProvider | null;
    /** False only for a player-code account that has not confirmed an email yet. */
    registrationComplete?: boolean;
    /** The email a player added that is waiting for confirmation. */
    pendingEmail?: string | null;
    accessToken: string;
    refreshToken: string;
    expiresAt: number | null;
  } | null;
  staff: { role: string; token: string; expiresAt: string } | null;
}

export const session = createStore<Session>({ ready: false, installationId: null, installToken: null, user: null, staff: null });

const freshInstallationId = () => `${Platform.OS}-${Crypto.randomUUID()}`;

export async function loadSession() {
  let installationId = await getSecret("ms.install.id");
  if (!installationId) {
    installationId = freshInstallationId();
    await setSecret("ms.install.id", installationId);
  }
  const [installToken, user, staff] = await Promise.all([readSecret("ms.install.token"), readUserSecret(), readSecret("ms.staff")]);
  const staffParsed = staff ? (JSON.parse(staff) as Session["staff"]) : null;
  let savedUser: Session["user"] = null;
  try {
    savedUser = user ? (JSON.parse(user) as Session["user"]) : null;
  } catch {
    savedUser = null; // unreadable: guest, rather than a crash at launch
  }
  session.set({
    ready: true,
    installationId,
    installToken,
    user: savedUser,
    staff: staffParsed && Date.parse(staffParsed.expiresAt) > Date.now() ? staffParsed : null,
  });
}

const readSecret = (key: string) => getSecret(key).catch(() => null);

// The keychain can refuse a read (a launch in the background before the phone was
// first unlocked). That is not a sign-out: the saved session is read again later.
let userUnread = false;
async function readUserSecret(): Promise<string | null> {
  try {
    const v = await getSecret("ms.user");
    userUnread = false;
    return v;
  } catch {
    userUnread = true;
    return null;
  }
}

/** Reads the saved session again if the keychain refused it at launch. */
export async function reloadUserIfUnread() {
  if (!userUnread || session.get().user) return;
  const raw = await readUserSecret();
  if (!raw) return;
  try {
    const user = JSON.parse(raw) as Session["user"];
    session.set((s) => (s.user ? s : { ...s, user }));
  } catch {
    /* unreadable */
  }
}

export async function saveInstallToken(token: string) {
  await setSecret("ms.install.token", token);
  session.set((s) => ({ ...s, installToken: token }));
}

/**
 * Starts this phone over as a new installation: the server refused its id (taken,
 * or its token is from before tokens carried a nonce). Register again afterwards.
 */
export async function resetInstallation() {
  const installationId = freshInstallationId();
  await setSecret("ms.install.id", installationId);
  await setSecret("ms.install.token", null);
  session.set((s) => ({ ...s, installationId, installToken: null }));
}

export async function saveUser(user: Session["user"]) {
  await setSecret("ms.user", user ? JSON.stringify(user) : null);
  session.set((s) => ({ ...s, user }));
}

/** Changes some fields of the signed-in user (no-op when signed out or another user took over). */
export async function patchUser(userId: string, patch: Partial<NonNullable<Session["user"]>>) {
  const u = session.get().user;
  if (!u || u.id !== userId) return;
  await saveUser({ ...u, ...patch });
}

export async function saveStaff(staff: Session["staff"]) {
  await setSecret("ms.staff", staff ? JSON.stringify(staff) : null);
  session.set((s) => ({ ...s, staff }));
}

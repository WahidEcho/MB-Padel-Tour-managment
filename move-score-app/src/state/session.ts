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
  /**
   * The staff sign-in. `referee` and `court` (referee PINs, migration 0035): who signed in
   * with their PIN, as a court referee ("Court 1") or a master referee (court null).
   */
  staff: { role: string; token: string; expiresAt: string; referee?: { name: string; role: "referee" | "master_referee" } | null; court?: string | null } | null;
  /**
   * After switching courts (court codes): the old court's carry-over tokens, each for
   * the matches this phone still had unsent points or an unfinished match on. Sent
   * only with calls about those matches; dropped once they are sent and finished.
   */
  staffCarry: StaffCarry[];
}

export interface StaffCarry {
  token: string;
  matchIds: string[];
  court: string | null;
  expiresAt: string;
}

export const session = createStore<Session>({ ready: false, installationId: null, installToken: null, user: null, staff: null, staffCarry: [] });

const freshInstallationId = () => `${Platform.OS}-${Crypto.randomUUID()}`;

export async function loadSession() {
  let installationId = await getSecret("ms.install.id");
  if (!installationId) {
    installationId = freshInstallationId();
    await setSecret("ms.install.id", installationId);
  }
  const [installToken, user, staff, carry] = await Promise.all([readSecret("ms.install.token"), readUserSecret(), readSecret("ms.staff"), readSecret("ms.staff.carry")]);
  let staffCarry: StaffCarry[] = [];
  try {
    staffCarry = carry ? (JSON.parse(carry) as StaffCarry[]).filter((c) => Date.parse(c.expiresAt) > Date.now()) : [];
  } catch {
    staffCarry = [];
  }
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
    staffCarry,
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

export async function saveStaffCarry(staffCarry: StaffCarry[]) {
  const live = staffCarry.filter((c) => c.matchIds.length && Date.parse(c.expiresAt) > Date.now()).slice(-3);
  await setSecret("ms.staff.carry", live.length ? JSON.stringify(live) : null);
  session.set((s) => ({ ...s, staffCarry: live }));
}

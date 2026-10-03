/**
 * Who this phone is to the server: its installation (always), a signed-in user
 * (optional, Apple or Google), and a staff role (when a referee code was entered).
 */
import { Platform } from "react-native";
import * as Crypto from "expo-crypto";
import { createStore } from "./store";
import { getSecret, setSecret } from "./kv";

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
    provider?: "apple" | "google" | null;
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
  const [installToken, user, staff] = await Promise.all([getSecret("ms.install.token"), getSecret("ms.user"), getSecret("ms.staff")]);
  const staffParsed = staff ? (JSON.parse(staff) as Session["staff"]) : null;
  session.set({
    ready: true,
    installationId,
    installToken,
    user: user ? JSON.parse(user) : null,
    staff: staffParsed && Date.parse(staffParsed.expiresAt) > Date.now() ? staffParsed : null,
  });
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

export async function saveStaff(staff: Session["staff"]) {
  await setSecret("ms.staff", staff ? JSON.stringify(staff) : null);
  session.set((s) => ({ ...s, staff }));
}

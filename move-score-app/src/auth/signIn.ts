/**
 * Apple and Google sign-in. The phone gets an identity token from the system,
 * the server turns it into a Move Score session; no database key is in the app.
 */
import { Platform } from "react-native";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Crypto from "expo-crypto";
import { api } from "../api/client";
import { saveUser } from "../state/session";
import { syncFollows } from "../state/follows";
import { config } from "../config";

interface SessionReply {
  userId: string;
  displayName: string | null;
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
}

async function finish(r: SessionReply) {
  await saveUser({ id: r.userId, name: r.displayName, accessToken: r.accessToken, refreshToken: r.refreshToken, expiresAt: r.expiresAt });
  await syncFollows(true);
}

export async function appleAvailable(): Promise<boolean> {
  return Platform.OS === "ios" && (await AppleAuthentication.isAvailableAsync());
}

export async function signInWithApple() {
  const raw = Crypto.randomUUID();
  const hashed = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, raw);
  const c = await AppleAuthentication.signInAsync({
    requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME],
    nonce: hashed,
  });
  if (!c.identityToken) throw new Error("Apple did not return a sign-in token.");
  const name = [c.fullName?.givenName, c.fullName?.familyName].filter(Boolean).join(" ") || undefined;
  await finish(
    await api<SessionReply>("/api/mobile/v1/auth/session", {
      body: { provider: "apple", idToken: c.identityToken, nonce: raw, authorizationCode: c.authorizationCode, ageConfirmed: true, displayName: name },
    }),
  );
}

export async function signInWithGoogle() {
  const { GoogleSignin } = await import("@react-native-google-signin/google-signin");
  GoogleSignin.configure({ webClientId: config.googleWebClientId ?? undefined, iosClientId: config.googleIosClientId ?? undefined });
  if (Platform.OS === "android") await GoogleSignin.hasPlayServices();
  const res = await GoogleSignin.signIn();
  const idToken = (res as { data?: { idToken?: string | null } }).data?.idToken;
  if (!idToken) throw new Error("Google sign-in was cancelled.");
  await finish(await api<SessionReply>("/api/mobile/v1/auth/session", { body: { provider: "google", idToken, ageConfirmed: true } }));
}

export async function signOut() {
  await saveUser(null);
  try {
    const { GoogleSignin } = await import("@react-native-google-signin/google-signin");
    await GoogleSignin.signOut();
  } catch {
    /* not signed in with Google */
  }
}

export async function deleteAccount() {
  await api("/api/mobile/v1/me/account", { method: "DELETE", who: "me" });
  await signOut();
}

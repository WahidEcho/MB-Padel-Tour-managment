/**
 * Apple and Google sign-in. No database key is in the app: the server turns
 * what the phone brings back into a Move Score session.
 *
 * - Apple (iPhone): the system's native Sign in with Apple sheet; its identity token goes to the server.
 * - Google: Supabase Auth's OAuth flow inside the in-app browser sheet
 *   (ASWebAuthenticationSession on iOS, Custom Tabs on Android, a popup on the web
 *   preview), never the outside browser. PKCE: the phone keeps the verifier and
 *   sends only its challenge; the code Supabase sends back is useless without it.
 */
import { Platform } from "react-native";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Crypto from "expo-crypto";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { authRedirectMessage, readAuthRedirect, type BrowserSignInProvider } from "@core";
import { api } from "../api/client";
import { saveUser } from "../state/session";
import { getSecret, setSecret } from "../state/kv";
import { syncFollows } from "../state/follows";
import { registerDevice } from "../push/register";
import { config } from "../config";

interface SessionReply {
  userId: string;
  displayName: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  provider?: "apple" | "google";
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
}

/** Thrown when the person backs out; the account screen stays quiet about it. */
export class SignInCancelled extends Error {
  constructor() {
    super("Sign-in cancelled");
  }
}

async function finish(r: SessionReply) {
  await saveUser({
    id: r.userId,
    name: r.displayName,
    email: r.email ?? null,
    avatarUrl: r.avatarUrl ?? null,
    provider: r.provider ?? null,
    accessToken: r.accessToken,
    refreshToken: r.refreshToken,
    expiresAt: r.expiresAt,
  });
  await syncFollows(true);
  // Links this phone to the account, so its alerts arrive here.
  await registerDevice(false).catch(() => undefined);
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

/* ---------- browser sign-in (Google) ---------- */

/**
 * Where the browser sheet comes back to: movescore://auth/callback in store and
 * development builds, exp://…/--/auth/callback in Expo Go, the page's own origin
 * on the web preview. Each must be on Supabase's redirect allow-list.
 */
export const authRedirectUrl = () => Linking.createURL("auth/callback");

// A sign-in waiting for its browser sheet. On Android the redirect reaches both the
// sheet's promise and the router (which opens /auth/callback); the promise finishes it.
let inFlight = false;
export const browserSignInInFlight = () => inFlight;

// The verifier, kept until the code comes back, in case Android stops the app while
// the sheet is open and the redirect cold-starts it on /auth/callback.
const PENDING = "ms.oauth.pending";
interface Pending {
  provider: BrowserSignInProvider;
  verifier: string;
  at: number;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const base64url = (b64: string) => b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function pkcePair() {
  const verifier = hex(Crypto.getRandomBytes(32)); // 64 unreserved characters
  const challenge = base64url(await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, { encoding: Crypto.CryptoEncoding.BASE64 }));
  return { verifier, challenge };
}

async function exchange(url: string, pending: Pending) {
  const back = readAuthRedirect(url);
  if (back.error || !back.code) {
    const msg = authRedirectMessage(back);
    if (!msg) throw new SignInCancelled();
    throw new Error(msg);
  }
  await finish(
    await api<SessionReply>("/api/mobile/v1/auth/session", {
      body: { provider: pending.provider, code: back.code, codeVerifier: pending.verifier, ageConfirmed: true },
    }),
  );
}

export async function signInWithBrowser(provider: BrowserSignInProvider) {
  if (inFlight) return;
  inFlight = true;
  try {
    const redirectTo = authRedirectUrl();
    const { verifier, challenge } = await pkcePair();
    const pending: Pending = { provider, verifier, at: Date.now() };
    await setSecret(PENDING, JSON.stringify(pending));
    const start = `${config.apiBaseUrl}/api/mobile/v1/auth/oauth/${provider}?redirect_to=${encodeURIComponent(redirectTo)}&code_challenge=${challenge}`;
    let result: WebBrowser.WebBrowserAuthSessionResult;
    try {
      result = await WebBrowser.openAuthSessionAsync(start, redirectTo, { showInRecents: false });
    } finally {
      // Taken off the shelf before the exchange, so /auth/callback cannot trade the same code.
      await setSecret(PENDING, null);
    }
    if (result.type !== "success") throw new SignInCancelled();
    await exchange(result.url, pending);
  } finally {
    inFlight = false;
  }
}

export const signInWithGoogle = () => signInWithBrowser("google");

/**
 * For /auth/callback when the sheet's promise is gone (the app was restarted
 * while the browser was open): finishes the sign-in from the stored verifier.
 * Returns false when there was nothing to finish.
 */
export async function resumeBrowserSignIn(url: string): Promise<boolean> {
  if (inFlight) return false;
  const raw = await getSecret(PENDING);
  if (!raw) return false;
  await setSecret(PENDING, null);
  let pending: Pending;
  try {
    pending = JSON.parse(raw) as Pending;
  } catch {
    return false;
  }
  if (Date.now() - pending.at > 10 * 60_000) return false;
  await exchange(url, pending);
  return true;
}

export async function signOut() {
  await saveUser(null);
  // Registering again without a session unlinks this phone, so the account's alerts stop here.
  await registerDevice(false).catch(() => undefined);
}

export async function deleteAccount() {
  await api("/api/mobile/v1/me/account", { method: "DELETE", who: "me" });
  await signOut();
}

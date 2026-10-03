import { createHash } from "crypto";
import { describe, expect, it } from "vitest";
import {
  authRedirectMessage,
  isAppRedirect,
  isCodeChallenge,
  isCodeVerifier,
  readAuthRedirect,
  redirectWithError,
  supabaseAuthorizeUrl,
} from "./oauth";

const verifier = "a".repeat(20) + "0123456789abcdef0123456789abcdef0123456789abcdef";
const challenge = createHash("sha256").update(verifier).digest("base64url");

describe("PKCE values", () => {
  it("accepts a real verifier and its S256 challenge", () => {
    expect(isCodeVerifier(verifier)).toBe(true);
    expect(isCodeChallenge(challenge)).toBe(true);
  });
  it("rejects short, long or odd values", () => {
    expect(isCodeVerifier("short")).toBe(false);
    expect(isCodeVerifier("x".repeat(129))).toBe(false);
    expect(isCodeVerifier("a b".repeat(20))).toBe(false);
    expect(isCodeChallenge(`${challenge}=`)).toBe(false);
    expect(isCodeChallenge(challenge.replace(/./, "+"))).toBe(false);
  });
});

describe("app redirects", () => {
  it("allows the app scheme, Expo Go and a local web preview", () => {
    expect(isAppRedirect("movescore://auth/callback")).toBe(true);
    expect(isAppRedirect("exp://192.168.1.20:8081/--/auth/callback")).toBe(true);
    expect(isAppRedirect("http://localhost:8104/auth/callback")).toBe(true);
  });
  it("refuses other websites and schemes", () => {
    expect(isAppRedirect("https://evil.example/auth/callback")).toBe(false);
    expect(isAppRedirect("https://localhost.evil.example/x")).toBe(false);
    expect(isAppRedirect("javascript:alert(1)")).toBe(false);
    expect(isAppRedirect("otherapp://auth/callback")).toBe(false);
    expect(isAppRedirect(42)).toBe(false);
  });
});

describe("authorize URL", () => {
  it("asks Supabase for a PKCE Google sign-in back to the app", () => {
    const url = new URL(
      supabaseAuthorizeUrl("https://ref.supabase.co/", { provider: "google", redirectTo: "movescore://auth/callback", codeChallenge: challenge }),
    );
    expect(url.origin + url.pathname).toBe("https://ref.supabase.co/auth/v1/authorize");
    expect(url.searchParams.get("provider")).toBe("google");
    expect(url.searchParams.get("redirect_to")).toBe("movescore://auth/callback");
    expect(url.searchParams.get("code_challenge")).toBe(challenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("s256");
  });
});

describe("reading the way back", () => {
  it("finds the code in the query", () => {
    expect(readAuthRedirect("movescore://auth/callback?code=abc-123")).toEqual({ code: "abc-123", error: null, errorDescription: null });
  });
  it("finds errors in the query or the fragment", () => {
    const q = readAuthRedirect("movescore://auth/callback?error=server_error&error_description=Unable+to+exchange+external+code");
    expect(q.error).toBe("server_error");
    expect(authRedirectMessage(q)).toBe("Sign-in did not finish: Unable to exchange external code.");
    const h = readAuthRedirect("exp://x/--/auth/callback#error=invalid_request&error_description=bad%20state");
    expect(h).toEqual({ code: null, error: "invalid_request", errorDescription: "bad state" });
  });
  it("treats Google's cancel as backing out, not a failure", () => {
    expect(authRedirectMessage(readAuthRedirect("movescore://auth/callback?error=access_denied"))).toBeNull();
  });
  it("round-trips an error the server attaches", () => {
    const r = readAuthRedirect(redirectWithError("movescore://auth/callback", "provider_disabled", "Google sign-in is not switched on yet"));
    expect(r.error).toBe("provider_disabled");
    expect(r.errorDescription).toBe("Google sign-in is not switched on yet");
  });
});

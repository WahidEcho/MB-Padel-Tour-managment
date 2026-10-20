import { describe, expect, it, vi, afterEach } from "vitest";
import { generateKeyPair, exportPKCS8, importPKCS8 } from "jose";
import { appleRefreshToken, normalizePkcs8, revokeApple } from "./users";

describe("Sign in with Apple key handling", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("accepts the .p8 key however it was pasted", async () => {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const pem = await exportPKCS8(privateKey);
    const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s/g, "");
    const pastes = [
      pem,
      pem.replace(/\n/g, "\\n"),
      pem.replace(/\n/g, " "),
      pem.replace(/\n/g, ""),
      pem.replace(/\n/g, "\r\n"),
      body,
      `  ${pem}  `,
    ];
    for (const p of pastes) await expect(importPKCS8(normalizePkcs8(p), "ES256")).resolves.toBeTruthy();
  });

  it("a broken key never throws out of the sign-in or deletion steps", async () => {
    vi.stubEnv("APPLE_TEAM_ID", "TEAM123456");
    vi.stubEnv("APPLE_KEY_ID", "KEY1234567");
    vi.stubEnv("APPLE_CLIENT_ID", "org.example.app");
    vi.stubEnv("APPLE_SIGNIN_KEY_P8", "not a key at all");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(appleRefreshToken("code")).resolves.toBeNull();
    await expect(revokeApple("token")).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Apple being down never throws either", async () => {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    vi.stubEnv("APPLE_TEAM_ID", "TEAM123456");
    vi.stubEnv("APPLE_KEY_ID", "KEY1234567");
    vi.stubEnv("APPLE_CLIENT_ID", "org.example.app");
    vi.stubEnv("APPLE_SIGNIN_KEY_P8", (await exportPKCS8(privateKey)).replace(/\n/g, " "));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await expect(appleRefreshToken("code")).resolves.toBeNull();
    await expect(revokeApple("token")).resolves.toBe(false);
  });
});

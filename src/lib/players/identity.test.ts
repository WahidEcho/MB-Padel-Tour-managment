import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codeFingerprint, codesReady, contactHash, hashOneTimeCode, hashPlayerCode, openPlayerCode, playerCodePepper, revealCode, sealPlayerCode, hasCode } from "./codeVault";
import { chooseOpen, newOneTimeCode, normalizeOneTimeCode, OTP_LENGTH, OTP_MAX_ATTEMPTS, OTP_TTL_MS, verificationOpen } from "./otp";
import { otpTemplate, otpTemplateName } from "../messaging/otp";
import { withoutCode } from "../messaging/queue";
import { transactionalEmail } from "../messaging/templates";

const PEPPER = "p".repeat(40);

describe("player codes at rest (codeVault)", () => {
  it("needs PLAYER_CODE_PEPPER in production, derives one elsewhere", () => {
    expect(() => playerCodePepper({ NODE_ENV: "production" })).toThrow(/PLAYER_CODE_PEPPER/);
    expect(() => playerCodePepper({ NODE_ENV: "production", PLAYER_CODE_PEPPER: "short" })).toThrow();
    expect(playerCodePepper({ NODE_ENV: "production", PLAYER_CODE_PEPPER: PEPPER })).toBe(PEPPER);
    expect(playerCodePepper({ NODE_ENV: "test", AUTH_SECRET: "a" })).toHaveLength(43);
    expect(playerCodePepper({ NODE_ENV: "test", AUTH_SECRET: "a" })).not.toBe(playerCodePepper({ NODE_ENV: "test", AUTH_SECRET: "b" }));
    expect(codesReady({ NODE_ENV: "production" })).toBe(false);
    expect(codesReady({ NODE_ENV: "production", PLAYER_CODE_PEPPER: PEPPER })).toBe(true);
  });

  it("hashes codes as 64 hex characters, keyed and domain-separated", () => {
    const h = hashPlayerCode("ABCD2345", PEPPER);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPlayerCode("ABCD2345", PEPPER)).toBe(h);
    expect(hashPlayerCode("ABCD2346", PEPPER)).not.toBe(h);
    expect(hashPlayerCode("ABCD2345", "q".repeat(40))).not.toBe(h);
    // A one-time code or a contact never hashes like a player code.
    expect(hashOneTimeCode("id", "ABCD2345", PEPPER)).not.toBe(h);
    expect(contactHash("email", "ABCD2345", PEPPER)).not.toBe(h);
    expect(contactHash("email", " Sara@Example.com ", PEPPER)).toBe(contactHash("email", "sara@example.com", PEPPER));
    expect(contactHash("phone", "sara@example.com", PEPPER)).not.toBe(contactHash("email", "sara@example.com", PEPPER));
  });

  it("seals codes so only this server opens them", () => {
    const sealed = sealPlayerCode("ABCD2345", PEPPER);
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain("ABCD2345");
    expect(sealPlayerCode("ABCD2345", PEPPER)).not.toBe(sealed); // a fresh IV every time
    expect(openPlayerCode(sealed, PEPPER)).toBe("ABCD2345");
    expect(openPlayerCode(sealed, "q".repeat(40))).toBeNull();
    expect(openPlayerCode(sealed.slice(0, -2) + "AA", PEPPER)).toBeNull();
    expect(openPlayerCode("garbage", PEPPER)).toBeNull();
    expect(openPlayerCode(null, PEPPER)).toBeNull();
    // Something that opens but is not a code is refused.
    expect(openPlayerCode(sealPlayerCode("not a code", PEPPER), PEPPER)).toBeNull();
  });

  it("reveals the plain code (not hashed yet) or the sealed one", () => {
    const pepper = playerCodePepper();
    expect(revealCode({ access_code: "ABCD2345" })).toBe("ABCD2345");
    expect(revealCode({ access_code: null, access_code_hash: hashPlayerCode("WXYZ2345", pepper), access_code_sealed: sealPlayerCode("WXYZ2345", pepper) })).toBe("WXYZ2345");
    expect(revealCode({ access_code: null, access_code_hash: null, access_code_sealed: null })).toBeNull();
    expect(hasCode({ access_code: null, access_code_hash: "a".repeat(64) })).toBe(true);
    expect(hasCode({ access_code: null, access_code_hash: null })).toBe(false);
    expect(codeFingerprint("ABCD2345")).toMatch(/^[0-9a-f]{16}$/);
    expect(codeFingerprint("ABCD2345")).not.toContain("ABCD");
  });
});

describe("phone one-time codes (otp)", () => {
  it("are six digits", () => {
    for (let i = 0; i < 50; i++) expect(newOneTimeCode(randomInt)).toMatch(/^\d{6}$/);
    expect(OTP_LENGTH).toBe(6);
    expect(OTP_TTL_MS).toBe(10 * 60_000);
    expect(OTP_MAX_ATTEMPTS).toBe(5);
  });

  it("read what people type or paste", () => {
    expect(normalizeOneTimeCode("123456")).toBe("123456");
    expect(normalizeOneTimeCode(" 123 456 ")).toBe("123456");
    expect(normalizeOneTimeCode("123-456")).toBe("123456");
    expect(normalizeOneTimeCode("١٢٣٤٥٦")).toBe("123456");
    expect(normalizeOneTimeCode("123456 is your verification code.")).toBe("123456");
    expect(normalizeOneTimeCode("Your code: 654 321. Expires in 10 minutes.")).toBe("654321");
    expect(normalizeOneTimeCode("12345")).toBeNull();
    expect(normalizeOneTimeCode("1234567")).toBeNull();
    expect(normalizeOneTimeCode("codes 123456 and 654321")).toBeNull();
    expect(normalizeOneTimeCode(123456)).toBeNull();
    expect(normalizeOneTimeCode("1".repeat(200))).toBeNull();
  });

  it("close after use, five attempts or ten minutes", () => {
    const now = Date.parse("2026-10-13T10:00:00Z");
    const open = { expires_at: "2026-10-13T10:05:00Z", attempts: 0, consumed_at: null };
    expect(verificationOpen(open, now)).toBe("open");
    expect(verificationOpen({ ...open, attempts: 4 }, now)).toBe("open");
    expect(verificationOpen({ ...open, attempts: 5 }, now)).toBe("locked");
    expect(verificationOpen({ ...open, expires_at: "2026-10-13T09:59:59Z" }, now)).toBe("expired");
    expect(verificationOpen({ ...open, consumed_at: "2026-10-13T09:58:00Z" }, now)).toBe("used");
    expect(chooseOpen({ consumed_at: "2026-10-13T09:50:00Z" }, now)).toBe(true);
    expect(chooseOpen({ consumed_at: "2026-10-13T09:40:00Z" }, now)).toBe(false);
    expect(chooseOpen({ consumed_at: null }, now)).toBe(false);
  });
});

describe("the one-time code messages", () => {
  it("use the authentication template when it is set, a stand-in in a dry run, nothing live without it", () => {
    expect(otpTemplateName({ WA_OTP_TEMPLATE: "mb_login_code", WA_OTP_TEMPLATE_LANG: "en_US" } as unknown as NodeJS.ProcessEnv)).toEqual({ name: "mb_login_code", language: "en_US" });
    expect(otpTemplateName({ MESSAGING_DRY_RUN: "1" } as unknown as NodeJS.ProcessEnv)).toEqual({ name: "mb_login_code", language: "en" });
    expect(otpTemplateName({} as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(otpTemplateName({ WA_OTP_TEMPLATE: "Bad Name!" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    // The code is the body parameter and the copy-code button's parameter.
    expect(otpTemplate("123456", { WA_OTP_TEMPLATE: "mb_login_code" } as unknown as NodeJS.ProcessEnv)).toEqual({ name: "mb_login_code", language: "en", bodyParams: ["123456"], buttonParams: [{ index: 0, value: "123456" }] });
    expect(otpTemplate("123456", {} as unknown as NodeJS.ProcessEnv)).toBeNull();
  });

  it("email the code in the branded layout", () => {
    const e = transactionalEmail("login_code", { name: "Sara Ali", code: "123456" });
    expect(e.subject).toBe("Your Move Score code");
    expect(e.html).toContain("123456");
    expect(e.text).toContain("10 minutes");
  });

  it("queued announcement rows keep a reference to the player, never the code", () => {
    const v = withoutCode({ name: "Sara", code: "ABCD-2345", code_ref: "c0ffee00-0000-4000-8000-000000000000", app_link: "https://x" });
    expect(v).toEqual({ name: "Sara", code_ref: "c0ffee00-0000-4000-8000-000000000000", app_link: "https://x" });
    expect(JSON.stringify(v)).not.toContain("ABCD");
  });
});

describe("source rules for the identity work", () => {
  const root = join(__dirname, "..", "..", "..");
  const read = (p: string) => readFileSync(join(root, p), "utf8");

  it("codes are looked up by hash, never selected by the public projections", () => {
    const claims = read("src/lib/players/claims.ts");
    expect(claims).toMatch(/eq\("access_code_hash", typed\)/);
    for (const f of ["src/lib/public.ts", "src/lib/mobile/projection.ts", "src/lib/mobile/courts.ts"]) {
      expect(read(f), f).not.toMatch(/access_code_(hash|sealed)/);
    }
  });

  it("one-time codes and player codes never reach a delivery row in clear", () => {
    const queue = read("src/lib/messaging/queue.ts");
    expect(queue).toMatch(/vars: withoutCode\(r\.vars\)/);
    expect(queue).toMatch(/export async function sendOneTimeCode[\s\S]*?\[removed\][\s\S]*?vars: \{\},/);
    const send = read("src/app/admin/tournaments/[id]/players/actions.ts");
    expect(send).toMatch(/redact: \[code, plain\]/);
    expect(send).not.toMatch(/idempotencyKey: `[^`]*\$\{p\.access_code\}/);
  });

  it("the phone code is compared in constant time and counted before it is compared", () => {
    const src = read("src/lib/players/phoneLink.ts");
    const counted = src.indexOf("attempts: v.attempts + 1");
    const compared = src.indexOf("safeEqual(hashOneTimeCode(");
    expect(counted).toBeGreaterThan(-1);
    expect(compared).toBeGreaterThan(counted);
  });

  it("a code's siblings never cross into another organisation", () => {
    const src = read("src/lib/players/link.ts");
    expect(src).toMatch(/same\.filter\(\(s\) => org && orgOf\.get\(s\.tournament_id\) === org\)/);
  });
});

import { describe, expect, it } from "vitest";
import { assistanceMessage, callStatusLine, isWeakPin, nextCallStatus, normalizePin, shouldRealert, splitCodeAndPin } from "./rules";
import { generateRefereePin, hashRefereePin } from "./pin";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("PINs", () => {
  it("normalises four digits only", () => {
    expect(normalizePin("4821")).toBe("4821");
    expect(normalizePin(" 48 21 ")).toBe("4821");
    expect(normalizePin("482")).toBeNull();
    expect(normalizePin("48211")).toBeNull();
    expect(normalizePin("48a1")).toBeNull();
    expect(normalizePin(null)).toBeNull();
  });

  it("refuses weak PINs", () => {
    for (const p of ["0000", "7777", "1234", "6789", "9876", "3210"]) expect(isWeakPin(p), p).toBe(true);
    for (const p of ["4821", "1357", "0911"]) expect(isWeakPin(p), p).toBe(false);
  });

  it("hashes with the pepper and the organisation: same PIN, other organisation, other hash", () => {
    const a = hashRefereePin(ORG, "4821", "p".repeat(32));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRefereePin(ORG, "4821", "p".repeat(32))).toBe(a);
    expect(hashRefereePin(OTHER, "4821", "p".repeat(32))).not.toBe(a);
    expect(hashRefereePin(ORG, "4821", "q".repeat(32))).not.toBe(a);
    expect(a).not.toContain("4821");
  });

  it("generates a PIN that is not weak and not taken", () => {
    const pepper = "p".repeat(32);
    const taken = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const pin = generateRefereePin(ORG, taken, pepper)!;
      expect(pin).toMatch(/^\d{4}$/);
      expect(isWeakPin(pin)).toBe(false);
      const h = hashRefereePin(ORG, pin, pepper);
      expect(taken.has(h)).toBe(false);
      taken.add(h);
    }
  });
});

describe("1.0.1: the court code and the PIN in one field", () => {
  it("splits code-PIN, code PIN and code+PIN", () => {
    const want = { code: "K7QMW3XT9HRP", pin: "4821" };
    expect(splitCodeAndPin("K7QM-W3XT-9HRP-4821")).toEqual(want);
    expect(splitCodeAndPin("k7qm-w3xt-9hrp 4821")).toEqual(want);
    expect(splitCodeAndPin("K7QMW3XT9HRP4821")).toEqual(want);
    expect(splitCodeAndPin(" K7QM W3XT 9HRP  4821 ")).toEqual(want);
  });
  it("is null for anything else", () => {
    expect(splitCodeAndPin("K7QM-W3XT-9HRP")).toBeNull();
    expect(splitCodeAndPin("K7QM-W3XT-9HRP-48")).toBeNull();
    expect(splitCodeAndPin("K7QM-W3XT-9HRP-ABCD")).toBeNull();
    // 0 and 1 are not in the code alphabet: not a code.
    expect(splitCodeAndPin("K7QM-W3XT-9HR0-4821")).toBeNull();
    expect(splitCodeAndPin("some-password-1234")).toBeNull();
    expect(splitCodeAndPin(undefined)).toBeNull();
  });
});

describe("calls for assistance: the state machine", () => {
  it("open → On my way (a master only) → resolved", () => {
    expect(nextCallStatus("open", "acknowledge", "master")).toBe("acknowledged");
    expect(nextCallStatus("open", "acknowledge", "court")).toBeNull();
    expect(nextCallStatus("open", "acknowledge", "staff")).toBeNull();
    expect(nextCallStatus("acknowledged", "acknowledge", "master")).toBeNull();
    expect(nextCallStatus("acknowledged", "resolve", "master")).toBe("resolved");
    expect(nextCallStatus("open", "resolve", "master")).toBe("resolved");
    expect(nextCallStatus("open", "resolve", "staff")).toBe("resolved");
    expect(nextCallStatus("open", "resolve", "court")).toBeNull();
  });
  it("the court referee may cancel only before anyone answered", () => {
    expect(nextCallStatus("open", "cancel", "court")).toBe("cancelled");
    expect(nextCallStatus("acknowledged", "cancel", "court")).toBeNull();
    expect(nextCallStatus("acknowledged", "cancel", "staff")).toBe("cancelled");
  });
  it("a closed call never changes", () => {
    for (const s of ["resolved", "cancelled"] as const) for (const a of ["acknowledge", "resolve", "cancel"] as const) for (const w of ["master", "court", "staff"] as const) expect(nextCallStatus(s, a, w)).toBeNull();
  });
  it("re-alerts an open call at most every 10 seconds", () => {
    const now = Date.parse("2026-11-02T10:00:00Z");
    expect(shouldRealert({ status: "open", last_tap_at: "2026-11-02T09:59:55Z" }, now)).toBe(false);
    expect(shouldRealert({ status: "open", last_tap_at: "2026-11-02T09:59:49Z" }, now)).toBe(true);
    expect(shouldRealert({ status: "acknowledged", last_tap_at: "2026-11-02T09:00:00Z" }, now)).toBe(false);
  });
  it("words", () => {
    expect(assistanceMessage(" Sara ", "Court 3")).toBe("Referee Sara is calling for assistance at Court 3");
    expect(callStatusLine({ status: "acknowledged", acknowledged_by_name: "Omar" })).toBe("Omar is on the way");
    expect(callStatusLine({ status: "resolved", resolved_by_name: "Omar" })).toBe("Resolved by Omar");
  });
});

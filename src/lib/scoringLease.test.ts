import { describe, expect, it } from "vitest";
import { LEASE_RENEW_MS, LEASE_TTL_MS, defaultDeviceLabel, isLeaseLive, sanitizeLabel } from "./scoringLease";
import type { ScoringLease } from "./types";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");

function lease(over: Partial<ScoringLease> = {}): ScoringLease {
  return {
    id: "l1",
    match_id: "m1",
    tournament_id: "t1",
    device_id: "d1",
    device_label: "Device 1",
    revision: 0,
    acquired_at: new Date(NOW - 10_000).toISOString(),
    renewed_at: new Date(NOW - 2_000).toISOString(),
    expires_at: new Date(NOW + 10_000).toISOString(),
    released_at: null,
    transfer_request: null,
    ...over,
  };
}

describe("isLeaseLive", () => {
  it("is false when there is no lease at all — nobody has the match open", () => {
    expect(isLeaseLive(null, NOW)).toBe(false);
    expect(isLeaseLive(undefined, NOW)).toBe(false);
  });

  it("is true while the expiry is still ahead", () => {
    expect(isLeaseLive(lease({ expires_at: new Date(NOW + 1).toISOString() }), NOW)).toBe(true);
  });

  it("is false the instant the expiry passes — three missed renewals, not a heartbeat channel", () => {
    expect(isLeaseLive(lease({ expires_at: new Date(NOW - 1).toISOString() }), NOW)).toBe(false);
    expect(isLeaseLive(lease({ expires_at: new Date(NOW).toISOString() }), NOW)).toBe(false);
  });

  it("is false once explicitly released, even with time left on the expiry", () => {
    expect(
      isLeaseLive(lease({ expires_at: new Date(NOW + 10_000).toISOString(), released_at: new Date(NOW - 1).toISOString() }), NOW),
    ).toBe(false);
  });

  it("renewing three times in a row never lapses, and one missed renewal alone never expires it either", () => {
    // The whole point of TTL > RENEW: a single slow poll doesn't cost control.
    expect(LEASE_TTL_MS).toBeGreaterThan(LEASE_RENEW_MS * 2);
    const acquiredAt = NOW;
    let expiresAt = acquiredAt + LEASE_TTL_MS;
    for (let tick = 0; tick < 3; tick++) {
      const at = acquiredAt + tick * LEASE_RENEW_MS;
      expect(isLeaseLive(lease({ expires_at: new Date(expiresAt).toISOString() }), at)).toBe(true);
      expiresAt = at + LEASE_TTL_MS; // a renewal landing at `at`
    }
    // One missed renewal — the lease is still live for a while yet.
    const missedOnce = acquiredAt + LEASE_RENEW_MS + 1;
    expect(isLeaseLive(lease({ expires_at: new Date(acquiredAt + LEASE_TTL_MS).toISOString() }), missedOnce)).toBe(true);
  });
});

describe("defaultDeviceLabel", () => {
  it("takes the last four characters, so two devices rarely collide", () => {
    expect(defaultDeviceLabel("11112222-3333-4444-5555-6666777788ab")).toBe("Device 88AB");
  });

  it("ignores hyphens when finding the tail", () => {
    expect(defaultDeviceLabel("aaaa-bbbb-cccc-dddd")).toBe("Device DDDD");
  });

  it("falls back for an empty id rather than showing a blank label", () => {
    expect(defaultDeviceLabel("")).toBe("Another device");
  });
});

describe("sanitizeLabel", () => {
  it("keeps a reasonable label as given", () => {
    expect(sanitizeLabel("Courtside iPad", "device-1234")).toBe("Courtside iPad");
  });

  it("trims whitespace", () => {
    expect(sanitizeLabel("  Courtside iPad  ", "device-1234")).toBe("Courtside iPad");
  });

  it("falls back to the derived label for blank, missing or non-string input", () => {
    expect(sanitizeLabel("", "device-1234")).toBe(defaultDeviceLabel("device-1234"));
    expect(sanitizeLabel("   ", "device-1234")).toBe(defaultDeviceLabel("device-1234"));
    expect(sanitizeLabel(undefined, "device-1234")).toBe(defaultDeviceLabel("device-1234"));
    expect(sanitizeLabel(42, "device-1234")).toBe(defaultDeviceLabel("device-1234"));
  });

  it("never exceeds the database's 60-character check constraint", () => {
    const long = "x".repeat(500);
    expect(sanitizeLabel(long, "device-1234").length).toBeLessThanOrEqual(60);
  });
});

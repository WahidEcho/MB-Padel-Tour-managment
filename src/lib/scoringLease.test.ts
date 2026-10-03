import { describe, expect, it } from "vitest";
import {
  LEASE_RENEW_MS,
  LEASE_TTL_MS,
  NO_LEASE_VIEW,
  claimedLeaseView,
  createLeaseOrder,
  defaultDeviceLabel,
  isLeaseLive,
  nextLeaseView,
  sanitizeLabel,
  type LeaseSideView,
  type SeenLease,
} from "./scoringLease";
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

describe("nextLeaseView: one console's side of the lease", () => {
  const ME = "ios-me";
  const seen = (over: Partial<SeenLease> = {}): SeenLease => ({
    deviceId: ME,
    deviceLabel: "iPhone · app",
    isLive: true,
    transferRequest: null,
    ...over,
  });
  const scoring: LeaseSideView = { ...NO_LEASE_VIEW, isController: true, gained: 1 };

  it("keeps control when the server says the lease is this phone's, even under a handle (no install token)", () => {
    // The reported bug: the phone's own lease came back as "d-…" and every poll took control away.
    const v = nextLeaseView(scoring, seen({ deviceId: "d-uT0VRq1NxldFP6AI", heldByYou: true }), ME);
    expect(v.isController).toBe(true);
    expect(v.heldByOther).toBe(false);
    expect(v.lostTo).toBeNull();
    expect(v.gained).toBe(1); // still the same spell of control: no second reload
  });

  it("still recognises its own raw id from an older server without heldByYou", () => {
    expect(nextLeaseView(NO_LEASE_VIEW, seen(), ME).isController).toBe(true);
  });

  it("counts a gain once per spell of control", () => {
    const a = nextLeaseView(NO_LEASE_VIEW, seen({ heldByYou: true }), ME);
    const b = nextLeaseView(a, seen({ heldByYou: true }), ME);
    expect([a.gained, b.gained]).toEqual([1, 1]);
  });

  it("says control moved when another device holds the match it was scoring, and keeps saying it until regained or freed", () => {
    const moved = nextLeaseView(scoring, seen({ deviceId: "d-other", deviceLabel: "Web console", heldByYou: false }), ME);
    expect(moved).toMatchObject({ isController: false, heldByOther: true, holderLabel: "Web console", lostTo: "Web console" });
    const again = nextLeaseView(moved, seen({ deviceId: "d-other", deviceLabel: "Web console", heldByYou: false }), ME);
    expect(again.lostTo).toBe("Web console");
    expect(nextLeaseView(again, seen({ isLive: false, deviceId: "d-other" }), ME).lostTo).toBeNull();
    expect(nextLeaseView(again, seen({ heldByYou: true }), ME)).toMatchObject({ isController: true, lostTo: null, gained: 2 });
  });

  it("is plain read-only (no 'moved') for a phone that never held the match", () => {
    const v = nextLeaseView(NO_LEASE_VIEW, seen({ deviceId: "d-other", deviceLabel: "Pixel · app", heldByYou: false }), ME);
    expect(v).toMatchObject({ isController: false, heldByOther: true, lostTo: null });
  });

  it("shows a request to the holder, and a pending ask to the asker (by heldByYou/requestedByYou)", () => {
    const holder = nextLeaseView(scoring, seen({ heldByYou: true, transferRequest: { deviceId: "d-b", deviceLabel: "Pixel · app" } }), ME);
    expect(holder.incomingRequest?.deviceLabel).toBe("Pixel · app");
    const asker = nextLeaseView(NO_LEASE_VIEW, seen({ deviceId: "d-a", heldByYou: false, transferRequest: { deviceId: "d-me", deviceLabel: "x" }, requestedByYou: true }), ME);
    expect(asker.myRequestPending).toBe(true);
    expect(asker.incomingRequest).toBeNull();
  });

  it("a lapsed lease is nobody's", () => {
    expect(nextLeaseView(scoring, seen({ isLive: false, heldByYou: true }), ME)).toMatchObject({ isController: false, heldByOther: false, lostTo: null });
    expect(nextLeaseView(scoring, null, ME).isController).toBe(false);
  });
});

describe("claimedLeaseView", () => {
  it("a re-claim by the phone already scoring is not a new gain (re-opening never fights itself)", () => {
    const s: LeaseSideView = { ...NO_LEASE_VIEW, isController: true, gained: 3 };
    expect(claimedLeaseView(s, true, null)).toMatchObject({ isController: true, gained: 3 });
    expect(claimedLeaseView(NO_LEASE_VIEW, true, null)).toMatchObject({ isController: true, gained: 1 });
  });

  it("a refused re-claim (back from the background after a takeover) says control moved, never steals", () => {
    const s: LeaseSideView = { ...NO_LEASE_VIEW, isController: true, gained: 1 };
    expect(claimedLeaseView(s, false, "Web console")).toMatchObject({ isController: false, heldByOther: true, lostTo: "Web console" });
    expect(claimedLeaseView(NO_LEASE_VIEW, false, null)).toMatchObject({ heldByOther: true, holderLabel: "another device", lostTo: null });
  });
});

describe("createLeaseOrder: a stale poll never undoes a claim", () => {
  it("drops a poll that left before a claim came back", () => {
    const o = createLeaseOrder();
    const before = o.ask(); // poll leaves: the lease is free
    o.changed(); // claim goes out
    o.changed(); // claim comes back: this phone holds it
    expect(o.fresh(before)).toBe(false);
    expect(o.fresh(o.ask())).toBe(true);
  });

  it("drops a poll that left while a claim was on its way", () => {
    const o = createLeaseOrder();
    o.changed();
    const during = o.ask();
    o.changed();
    expect(o.fresh(during)).toBe(false);
  });

  it("applies polls in order: an older answer arriving late is dropped", () => {
    const o = createLeaseOrder();
    const first = o.ask();
    const second = o.ask();
    expect(o.fresh(second)).toBe(true);
    expect(o.fresh(first)).toBe(false);
  });
});

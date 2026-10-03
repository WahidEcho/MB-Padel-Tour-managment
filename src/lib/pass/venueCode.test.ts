import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.VENUE_QR_SECRET = "test-secret";
});

describe("venue code", async () => {
  const m = await import("./venueCode");
  const t = Date.parse("2026-11-04T10:00:00Z");
  it("accepts the current and previous window only", () => {
    const now = m.rotatingCode("jtf-2026", t);
    expect(m.checkVenueCode("jtf-2026", now, "Africa/Cairo", t)).toBe(true);
    expect(m.checkVenueCode("jtf-2026", now, "Africa/Cairo", t + m.WINDOW_SECONDS * 1000)).toBe(true);
    expect(m.checkVenueCode("jtf-2026", now, "Africa/Cairo", t + 3 * m.WINDOW_SECONDS * 1000)).toBe(false);
    expect(m.checkVenueCode("other-event", now, "Africa/Cairo", t)).toBe(false);
  });
  it("accepts today's staff code", () => {
    const day = m.eventDay("Africa/Cairo", t);
    expect(day).toBe("2026-11-04");
    expect(m.checkVenueCode("jtf-2026", m.dailyCode("jtf-2026", day), "Africa/Cairo", t)).toBe(true);
    expect(m.checkVenueCode("jtf-2026", m.dailyCode("jtf-2026", "2026-11-03"), "Africa/Cairo", t)).toBe(false);
  });
  it("stamps only the event's days", () => {
    expect(m.isEventDay("2026-11-04", "2026-11-02", "2026-11-08")).toBe(true);
    expect(m.isEventDay("2026-11-02", "2026-11-02", "2026-11-08")).toBe(true);
    expect(m.isEventDay("2026-11-08", "2026-11-02", "2026-11-08")).toBe(true);
    expect(m.isEventDay("2026-11-01", "2026-11-02", "2026-11-08")).toBe(false);
    expect(m.isEventDay("2026-11-09", "2026-11-02", "2026-11-08")).toBe(false);
    expect(m.isEventDay("2026-11-03", "2026-11-02", null)).toBe(false);
    expect(m.isEventDay("2026-11-03", null, null)).toBe(true);
  });
  it("counts the day in the event's zone, not UTC", () => {
    // 23:30 UTC on the 3rd is already the 4th in Cairo.
    expect(m.eventDay("Africa/Cairo", Date.parse("2026-11-03T23:30:00Z"))).toBe("2026-11-04");
  });
});

describe("match check-in code", async () => {
  const m = await import("./venueCode");
  const t = Date.parse("2026-11-04T10:00:30Z");
  const id = "6f0c1a52-6c55-4b4e-9d8f-3a1b2c3d4e5f";
  it("accepts the TV's current and previous code, and calls an older one expired", () => {
    const now = m.matchScreenCode(id, t);
    expect(now).toMatch(/^[A-Z2-9]{8}$/);
    expect(m.checkMatchCode(id, { c: now }, t)).toEqual({ ok: true, via: "screen" });
    expect(m.checkMatchCode(id, { c: now.toLowerCase() }, t + m.MATCH_WINDOW_SECONDS * 1000)).toEqual({ ok: true, via: "screen" });
    expect(m.checkMatchCode(id, { c: now }, t + 3 * m.MATCH_WINDOW_SECONDS * 1000)).toEqual({ ok: false, reason: "code_expired" });
    expect(m.checkMatchCode("another-match", { c: now }, t)).toEqual({ ok: false, reason: "bad_code" });
    expect(m.checkMatchCode(id, {}, t)).toEqual({ ok: false, reason: "bad_code" });
  });
  it("accepts the printed code for its own match only", () => {
    const p = m.matchPrintedCode(id);
    expect(p).toMatch(/^[A-Z2-9]{10}$/);
    expect(m.checkMatchCode(id, { p }, t)).toEqual({ ok: true, via: "printed" });
    expect(m.checkMatchCode("another-match", { p }, t)).toEqual({ ok: false, reason: "bad_code" });
  });
  it("builds the link the app parses", () => {
    expect(m.matchCheckinUrl("https://x.app/", id, { c: "ABCDEFGH" })).toBe(`https://x.app/m/${id}?c=ABCDEFGH`);
    expect(m.matchCheckinUrl("https://x.app", id, { p: "ABCDEFGHJK" })).toBe(`https://x.app/m/${id}?p=ABCDEFGHJK`);
  });
});

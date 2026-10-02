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

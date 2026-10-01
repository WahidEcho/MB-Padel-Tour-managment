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
});

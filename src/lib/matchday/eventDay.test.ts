import { describe, expect, it } from "vitest";
import { eventDay, isEventDay, isMatchDay } from "./eventDay";
import * as venue from "../pass/venueCode";

describe("eventDay", () => {
  it("counts the day in the event's zone", () => {
    // 22:30 UTC on 3 Nov is already 4 Nov in Cairo (UTC+2).
    const t = Date.parse("2026-11-03T22:30:00Z");
    expect(eventDay("Africa/Cairo", t)).toBe("2026-11-04");
    expect(eventDay("UTC", t)).toBe("2026-11-03");
  });

  it("is still exported from venueCode", () => {
    expect(venue.eventDay).toBe(eventDay);
    expect(venue.isEventDay).toBe(isEventDay);
  });
});

describe("isMatchDay", () => {
  const t = Date.parse("2026-11-04T10:00:00Z");
  const base = { status: "active", timezone: "Africa/Cairo", starts_on: "2026-11-02", ends_on: "2026-11-08" };

  it("is an active tournament on one of its days", () => {
    expect(isMatchDay(base, t)).toBe(true);
    expect(isMatchDay({ ...base, starts_on: "2026-11-05" }, t)).toBe(false);
    expect(isMatchDay({ ...base, ends_on: "2026-11-03" }, t)).toBe(false);
    expect(isMatchDay({ ...base, starts_on: "2026-11-04", ends_on: null }, t)).toBe(true);
  });

  it("needs the tournament to be active", () => {
    for (const status of ["draft", "completed", "archived"]) expect(isMatchDay({ ...base, status }, t, true)).toBe(false);
  });

  it("uses the tournament's own zone", () => {
    const late = Date.parse("2026-11-08T22:30:00Z"); // 9 Nov in Cairo
    expect(isMatchDay(base, late)).toBe(false);
    expect(isMatchDay({ ...base, timezone: "UTC" }, late)).toBe(true);
  });

  it("without dates, counts only while a match is live", () => {
    const undated = { status: "active", timezone: "Africa/Cairo", starts_on: null, ends_on: null };
    expect(isMatchDay(undated, t)).toBe(false);
    expect(isMatchDay(undated, t, false)).toBe(false);
    expect(isMatchDay(undated, t, true)).toBe(true);
  });

  it("survives a bad time zone", () => {
    expect(isMatchDay({ ...base, timezone: "Not/AZone" }, t)).toBe(true);
  });
});

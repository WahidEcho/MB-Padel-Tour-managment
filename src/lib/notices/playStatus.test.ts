import { describe, expect, it } from "vitest";
import {
  MAJOR_NOTICE_MS,
  RESUMED_SHOWN_MS,
  STATUS_STALE_MS,
  currentMajorAnnouncement,
  noticeBanners,
  playStatusProblem,
  playStatusPush,
  publicPlayStatus,
} from "./playStatus";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("the play status viewers see", () => {
  it("shows nothing for normal or nothing stored", () => {
    expect(publicPlayStatus(null, NOW)).toBeNull();
    expect(publicPlayStatus({ kind: "normal", updatedAt: ago(0) }, NOW)).toBeNull();
  });

  it("shows a delay with its message and resume time", () => {
    const s = publicPlayStatus({ kind: "delayed", message: "  Rain. Courts drying.  ", resumeAt: "2026-11-03T13:30:00Z", updatedAt: ago(60_000) }, NOW);
    expect(s).toEqual({ kind: "delayed", message: "Rain. Courts drying.", resumeAt: "2026-11-03T13:30:00Z", updatedAt: ago(60_000) });
  });

  it("drops a resume time on 'resumed' and a bad one anywhere", () => {
    expect(publicPlayStatus({ kind: "resumed", resumeAt: "2026-11-03T13:30:00Z", updatedAt: ago(0) }, NOW)?.resumeAt).toBeNull();
    expect(publicPlayStatus({ kind: "suspended", resumeAt: "soon", updatedAt: ago(0) }, NOW)?.resumeAt).toBeNull();
  });

  it("lets 'resumed' fade after a while and a forgotten delay after a day", () => {
    expect(publicPlayStatus({ kind: "resumed", updatedAt: ago(RESUMED_SHOWN_MS - 1000) }, NOW)?.kind).toBe("resumed");
    expect(publicPlayStatus({ kind: "resumed", updatedAt: ago(RESUMED_SHOWN_MS + 1000) }, NOW)).toBeNull();
    expect(publicPlayStatus({ kind: "suspended", updatedAt: ago(STATUS_STALE_MS + 1000) }, NOW)).toBeNull();
  });

  it("ignores an unknown kind", () => {
    expect(publicPlayStatus({ kind: "storm" as never, updatedAt: ago(0) }, NOW)).toBeNull();
  });
});

describe("the major announcement banner", () => {
  const a = (id: string, level: string, msAgo: number) => ({ id, title: id, body: null, level, publishedAt: ago(msAgo) });

  it("is the newest major one still recent", () => {
    expect(currentMajorAnnouncement([a("old", "major", 3_600_000), a("info", "info", 0), a("new", "major", 60_000)], NOW)?.id).toBe("new");
  });

  it("expires after a few hours", () => {
    expect(currentMajorAnnouncement([a("x", "major", MAJOR_NOTICE_MS + 1)], NOW)).toBeNull();
  });

  it("puts the play status first", () => {
    const banners = noticeBanners({
      playStatus: { kind: "suspended", message: "Lightning", resumeAt: null, updatedAt: ago(0) },
      announcements: [a("Semis moved indoors", "major", 0)],
      now: NOW,
    });
    expect(banners.map((b) => [b.tone, b.title])).toEqual([
      ["suspended", "Play suspended"],
      ["major", "Semis moved indoors"],
    ]);
    expect(noticeBanners({ now: NOW })).toEqual([]);
  });
});

describe("the push and the form", () => {
  it("names the event and the resume time", () => {
    expect(playStatusPush({ kind: "delayed", eventName: "Junior Finals", message: "Rain", resumeClock: "15:30" })).toEqual({
      title: "Play delayed · Junior Finals",
      body: "Rain. Play expected to resume about 15:30",
    });
    expect(playStatusPush({ kind: "resumed", eventName: "Junior Finals", message: null, resumeClock: "15:30" }).body).toBe("Play is under way again.");
  });

  it("refuses a bad kind, a long message and a bad time", () => {
    expect(playStatusProblem({ kind: "x", message: "", resumeAt: null })).toMatch(/Pick/);
    expect(playStatusProblem({ kind: "delayed", message: "x".repeat(201), resumeAt: null })).toMatch(/200/);
    expect(playStatusProblem({ kind: "delayed", message: "", resumeAt: "nope" })).toMatch(/HH:MM/);
    expect(playStatusProblem({ kind: "delayed", message: "Rain", resumeAt: "2026-11-03T13:30:00Z" })).toBeNull();
  });
});

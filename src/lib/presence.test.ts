import { describe, it, expect } from "vitest";
import {
  BEAT_SECONDS,
  LIVE_WINDOW_SECONDS,
  MAX_KEY_LENGTH,
  SWEEP_AFTER_SECONDS,
  isPresencePage,
  isVisitorId,
  presenceKey,
  watchingLabel,
} from "./presence";

describe("presenceKey", () => {
  it("namespaces by tournament and page", () => {
    expect(presenceKey("abc", "overview")).toBe("t:abc:overview");
    expect(presenceKey("abc", "leaderboard")).not.toBe(presenceKey("abc", "overview"));
    expect(presenceKey("abc", "overview")).not.toBe(presenceKey("def", "overview"));
  });

  it("stays inside the length the column allows", () => {
    // A uuid tournament id plus the longest page name is the worst case.
    const longest = presenceKey("00000000-0000-0000-0000-000000000000", "leaderboard");
    expect(longest.length).toBeLessThanOrEqual(MAX_KEY_LENGTH);
  });
});

describe("isPresencePage", () => {
  it("accepts the pages that can report", () => {
    for (const p of ["overview", "leaderboard", "live", "bracket", "winner", "session"]) {
      expect(isPresencePage(p)).toBe(true);
    }
  });

  it("rejects anything else, so a caller cannot invent a key segment", () => {
    for (const p of ["", "admin", "t:x:y", "OVERVIEW", null, undefined, 7, {}]) {
      expect(isPresencePage(p)).toBe(false);
    }
  });
});

describe("isVisitorId", () => {
  it("accepts a lowercase uuid", () => {
    expect(isVisitorId("3f2504e0-4f89-41d3-9a0c-0305e82c3301")).toBe(true);
  });

  it("rejects anything that is not one", () => {
    for (const v of [
      "",
      "not-a-uuid",
      "3F2504E0-4F89-41D3-9A0C-0305E82C3301", // uppercase: crypto.randomUUID is lowercase
      "3f2504e0-4f89-41d3-9a0c-0305e82c3301x",
      "a".repeat(400),
      null,
      42,
    ]) {
      expect(isVisitorId(v)).toBe(false);
    }
  });
});

describe("the beat and the window agree", () => {
  it("counts a visitor through two dropped beats", () => {
    // Otherwise one flaky request makes people blink out of the count.
    expect(LIVE_WINDOW_SECONDS).toBeGreaterThanOrEqual(BEAT_SECONDS * 2);
  });

  it("sweeps only well after a row has stopped counting", () => {
    expect(SWEEP_AFTER_SECONDS).toBeGreaterThan(LIVE_WINDOW_SECONDS);
  });
});

describe("watchingLabel", () => {
  it("says nothing when you are the only one there", () => {
    expect(watchingLabel(0)).toBeNull();
    expect(watchingLabel(1)).toBeNull();
  });

  it("reads as a plain count", () => {
    expect(watchingLabel(2)).toBe("2 watching");
    expect(watchingLabel(37)).toBe("37 watching");
  });

  it("caps rather than reporting a precise large number", () => {
    expect(watchingLabel(999)).toBe("999 watching");
    expect(watchingLabel(1000)).toBe("999+ watching");
    expect(watchingLabel(50_000)).toBe("999+ watching");
  });
});

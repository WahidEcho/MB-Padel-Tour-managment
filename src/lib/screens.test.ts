import { describe, it, expect } from "vitest";
import { isValidScreenKey, planApplyToScreens } from "./screens";
import { courtsForScreen, defaultScreenSettings } from "./data";
import { normalizeDisplayMode, type Court, type ScreenSettings } from "./types";

function screen(over: Partial<ScreenSettings> = {}): ScreenSettings {
  return { ...defaultScreenSettings("t1", over.screen_key ?? "main"), id: over.screen_key ?? "s", ...over };
}

const courts: Court[] = [1, 2, 3, 4].map((n) => ({
  id: `c${n}`,
  tournament_id: "t1",
  court_name: `Court ${n}`,
  court_order: n,
  is_active: true,
}));

describe("isValidScreenKey", () => {
  it("accepts what slugify produces", () => {
    for (const k of ["main", "tv-2", "lobby", "court-1-3", "a", "x9"]) {
      expect(isValidScreenKey(k)).toBe(true);
    }
  });

  it("rejects anything that is not a plain URL segment", () => {
    for (const k of ["", "TV-2", "tv 2", "../secret", "tv/2", "-tv", "tv_2", "a".repeat(61)]) {
      expect(isValidScreenKey(k)).toBe(false);
    }
  });
});

describe("normalizeDisplayMode", () => {
  it("collapses both legacy live modes to one", () => {
    expect(normalizeDisplayMode("live_court")).toBe("live");
    expect(normalizeDisplayMode("all_live")).toBe("live");
    expect(normalizeDisplayMode("live")).toBe("live");
  });

  it("leaves every other mode alone", () => {
    for (const m of ["leaderboard", "bracket", "winner", "ceremony", "sponsors", "holding"] as const) {
      expect(normalizeDisplayMode(m)).toBe(m);
    }
  });
});

describe("courtsForScreen", () => {
  it("empty coverage means every court, so screens predating coverage still work", () => {
    expect(courtsForScreen({ court_ids: [] }, courts)).toHaveLength(4);
  });

  it("keeps court order rather than the order they were ticked", () => {
    const picked = courtsForScreen({ court_ids: ["c3", "c1"] }, courts);
    expect(picked.map((c) => c.court_name)).toEqual(["Court 1", "Court 3"]);
  });

  it("drops courts that no longer exist", () => {
    // court_ids is a plain array with no foreign key, so a deleted court leaves
    // a dangling id behind. It must not blank the screen.
    const picked = courtsForScreen({ court_ids: ["c1", "deleted"] }, courts);
    expect(picked.map((c) => c.id)).toEqual(["c1"]);
  });
});

describe("planApplyToScreens", () => {
  const tv1 = screen({ screen_key: "tv-1", court_ids: ["c1", "c2"] });
  const tv2 = screen({ screen_key: "tv-2", court_ids: ["c3", "c4"] });
  const lobby = screen({ screen_key: "lobby", court_ids: [] });
  const all = [tv1, tv2, lobby];
  const exists = (id: string) => courts.some((c) => c.id === id);

  it("pushes a mode to every screen", () => {
    const plan = planApplyToScreens({ display_mode: "sponsors" }, all, exists);
    expect(plan).toHaveLength(3);
    expect(plan.every((p) => p.patch.display_mode === "sponsors")).toBe(true);
  });

  it("never writes coverage, so one click cannot undo the court split", () => {
    const plan = planApplyToScreens(
      { display_mode: "live", court_ids: ["c1"] },
      all,
      exists,
    );
    expect(plan).toHaveLength(3);
    expect(plan.every((p) => p.patch.court_ids === undefined)).toBe(true);
  });

  it("skips a screen the pinned court is not on, and keeps the ones it is", () => {
    const plan = planApplyToScreens({ focus_court_id: "c1" }, all, exists);
    // tv-2 covers courts 3 and 4, so pinning it to court 1 is meaningless.
    expect(plan.map((p) => p.screen.screen_key)).toEqual(["tv-1", "lobby"]);
  });

  it("a screen with no coverage covers everything, so any pin applies", () => {
    const plan = planApplyToScreens({ focus_court_id: "c4" }, [lobby], exists);
    expect(plan).toHaveLength(1);
  });

  it("refuses to pin to a court that has been deleted", () => {
    const plan = planApplyToScreens({ focus_court_id: "gone" }, all, exists);
    expect(plan).toHaveLength(0);
  });

  it("clearing the pin applies everywhere", () => {
    const plan = planApplyToScreens({ focus_court_id: null }, all, exists);
    expect(plan).toHaveLength(3);
  });
});

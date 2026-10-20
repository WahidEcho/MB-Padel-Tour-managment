import { describe, expect, it } from "vitest";
import { checkDisplayName, DISPLAY_NAME_MAX } from "./displayName";

const ok = (v: unknown) => {
  const r = checkDisplayName(v);
  return r.ok ? r.name : null;
};

describe("checkDisplayName", () => {
  it("trims and collapses spaces", () => {
    expect(ok("  Mona   El Sayed ")).toBe("Mona El Sayed");
  });
  it("keeps names in any script, with ordinary punctuation", () => {
    expect(ok("محمد وحيد")).toBe("محمد وحيد");
    expect(ok("Zoë O'Brien-Smith")).toBe("Zoë O'Brien-Smith");
    expect(ok("李雷")).toBe("李雷");
  });
  it("refuses empty, blank and non-strings", () => {
    for (const v of ["", "   ", null, undefined, 42, {}, ["a"], "--", "…"]) expect(checkDisplayName(v).ok).toBe(false);
  });
  it("allows 60 characters, refuses 61 (counted by code point)", () => {
    expect(ok("a".repeat(DISPLAY_NAME_MAX))).toBe("a".repeat(60));
    expect(checkDisplayName("a".repeat(61)).ok).toBe(false);
    expect(ok("Mo😀".repeat(20))).not.toBeNull(); // 60 code points, 80 UTF-16 units
    expect(checkDisplayName("😀😀").ok).toBe(false); // needs a letter or a number
  });
  it("refuses control characters and line breaks", () => {
    for (const v of ["Mona\nFan", "Mona\tFan", "Mona\u0000", "Mona\u007F", "Mona\u0085"]) expect(checkDisplayName(v).ok).toBe(false);
  });
  it("refuses bidi overrides, isolates and invisible characters", () => {
    for (const v of ["Mona\u202Eraf", "\u2066Mona\u2069", "Mo\u200Bna", "\uFEFFMona", "Mona\u200F", "Mona\u2028"]) expect(checkDisplayName(v).ok).toBe(false);
  });
  it("keeps the joiners some scripts need", () => {
    expect(ok("\u0645\u06CC\u200C\u062E\u0648\u0627\u0645")).not.toBeNull();
  });
  it("refuses markup brackets", () => {
    expect(checkDisplayName("<b>Mona</b>").ok).toBe(false);
  });
});

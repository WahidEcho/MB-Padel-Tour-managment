import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCoachLineup, coachActorLabel, coachLineupSettings, coachLineupWindow, deadlineFrom, newlyAccepted, sameLineup, submittedNote } from "./lineupEntry";

const ON = { on: true, deadlineMinutes: null };
const base = { settings: ON, locked: false, tieStatus: "scheduled" as const, scheduledTime: "2026-10-21T08:00:00.000Z", opponentKnown: true, singlesEditable: true };
const NOW = Date.parse("2026-10-21T07:00:00.000Z");

describe("coach line-up entry: the switch", () => {
  it("is off unless an admin turned it on (missing, junk, a truthy string)", () => {
    for (const fc of [null, {}, { ties: {} }, { ties: { coachLineups: {} } }, { ties: { coachLineups: { on: "true" } } }, { ties: { coachLineups: { on: false } } }, { coachLineups: { on: true } }]) {
      expect(coachLineupSettings(fc).on).toBe(false);
    }
    expect(coachLineupSettings({ ties: { coachLineups: { on: true } } })).toEqual({ on: true, deadlineMinutes: null });
    expect(coachLineupSettings({ ties: { coachLineups: { on: true, deadlineMinutes: 30 } } }).deadlineMinutes).toBe(30);
  });
  it("is not part of the scoring features or match-day defaults (nothing turns it on by default)", async () => {
    const rules = await import("../matchday/rules");
    expect(JSON.stringify(rules.SCORING_FEATURES_ON)).not.toMatch(/coach/i);
    expect(JSON.stringify(rules.DEFAULT_MATCH_DAY_RULES)).not.toMatch(/coach/i);
  });
  it("deadlines: whole minutes in 0–1440, empty is until the lock", () => {
    expect(deadlineFrom("")).toBeNull();
    expect(deadlineFrom(null)).toBeNull();
    expect(deadlineFrom("abc")).toBeNull();
    expect(deadlineFrom("30")).toBe(30);
    expect(deadlineFrom(-5)).toBe(0);
    expect(deadlineFrom(99999)).toBe(1440);
  });
});

describe("coach line-up entry: the window", () => {
  it("open before the lock; closed by the switch, the lock, play, an unknown opponent, the deadline", () => {
    expect(coachLineupWindow(base, NOW)).toEqual({ open: true, closed: null, deadline: null });
    expect(coachLineupWindow({ ...base, settings: { on: false, deadlineMinutes: 30 } }, NOW).closed).toBe("feature_off");
    expect(coachLineupWindow({ ...base, locked: true }, NOW).closed).toBe("locked");
    expect(coachLineupWindow({ ...base, tieStatus: "live" }, NOW).closed).toBe("under_way");
    expect(coachLineupWindow({ ...base, singlesEditable: false }, NOW).closed).toBe("under_way");
    expect(coachLineupWindow({ ...base, tieStatus: "completed" }, NOW).closed).toBe("finished");
    expect(coachLineupWindow({ ...base, opponentKnown: false }, NOW).closed).toBe("opponent_unknown");
    const d = coachLineupWindow({ ...base, settings: { on: true, deadlineMinutes: 30 } }, NOW);
    expect(d).toEqual({ open: true, closed: null, deadline: "2026-10-21T07:30:00.000Z" });
    expect(coachLineupWindow({ ...base, settings: { on: true, deadlineMinutes: 90 } }, NOW).closed).toBe("deadline");
    // No time set: a deadline cannot apply, open until the lock.
    expect(coachLineupWindow({ ...base, scheduledTime: null, settings: { on: true, deadlineMinutes: 90 } }, NOW).open).toBe(true);
  });
});

describe("coach line-up entry: checks and words", () => {
  const squad = [
    { id: "p1", name: "Ali" },
    { id: "p2", name: "Omar" },
    { id: "p3", name: "Karim" },
  ];
  it("both singles needed; the doubles can be to be named; Reg 43 is a warning", () => {
    expect(checkCoachLineup({ S1: "p1", S2: null, D: [null, null] }, squad).problems.map((p) => p.code)).toEqual(["missing_s2"]);
    expect(checkCoachLineup({ S1: "p1", S2: "p2", D: [null, null] }, squad)).toEqual({ problems: [], warnings: [] });
    const w = checkCoachLineup({ S1: "p2", S2: "p1", D: [null, null] }, squad).warnings;
    expect(w.map((x) => [x.code, x.reg])).toEqual([["order_of_merit", "43"]]);
    expect(newlyAccepted(w, [w[0].key])).toEqual([]);
    expect(newlyAccepted(w, [])).toHaveLength(1);
  });
  it("same line-up ignores the doubles' empty places", () => {
    expect(sameLineup({ S1: "a", S2: "b", D: [null, null] }, { S1: "a", S2: "b", D: [] })).toBe(true);
    expect(sameLineup({ S1: "a", S2: "b", D: [] }, { S1: "b", S2: "a", D: [] })).toBe(false);
  });
  it("names and notes", () => {
    expect(coachActorLabel("Egypt")).toBe("Coach of Egypt");
    expect(submittedNote("2026-10-21T07:32:00.000Z", "Africa/Cairo")).toBe("Submitted by the coach at 10:32");
  });
});

/* ---------------- source scans: coach routes ---------------- */

const APP = join(__dirname, "..", "..", "app");
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /route\.tsx?$/.test(n) ? [p] : [];
  });
}

describe("coach routes: coach credential only, writes behind the switch", () => {
  const routes = walk(join(APP, "api", "mobile", "v1", "coach")).map((p) => ({ r: relative(APP, p), text: readFileSync(p, "utf8") }));
  it("finds the coach routes", () => {
    expect(routes.length).toBeGreaterThanOrEqual(6);
  });
  for (const { r, text } of routes) {
    it(`${r}: never a staff guard; every handler but sign-in resolves the coach`, () => {
      expect(text).not.toMatch(/staffRoute\(|staffReaching\(|requireStaff\(|currentStaff/);
      if (!r.includes("coach/session")) {
        const handlers = [...text.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)].length;
        expect((text.match(/coachRoute\(\)/g) ?? []).length).toBeGreaterThanOrEqual(handlers);
      }
    });
    it(`${r}: writes only through the switched line-up submission`, () => {
      if (r.includes("coach/session")) return;
      const writes = [...text.matchAll(/export async function (POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]);
      if (!writes.length) return;
      expect(r).toMatch(/coach\/ties\/\[tieId\]\/lineup\/route\.ts$/);
      expect(text).toContain("submitCoachLineup(");
    });
  }
  it("submitCoachLineup refuses while the switch is off before anything else is written", () => {
    const src = readFileSync(join(__dirname, "lineups.ts"), "utf8");
    const fn = src.slice(src.indexOf("export async function submitCoachLineup"));
    const off = fn.indexOf('"feature_off"');
    expect(off).toBeGreaterThan(0);
    for (const later of ["takeRateLimit(", '.from("audit_logs")', "recordLineupException(", "tellOfficials("]) expect(fn.indexOf(later)).toBeGreaterThan(off);
  });
  it("the coach's own answer never selects another team's squad or a private player column", () => {
    const src = readFileSync(join(__dirname, "lineups.ts"), "utf8");
    expect(src).not.toMatch(/select\("\*"\)/);
    const selects = [...src.matchAll(/\.select\("([^"]*)"\)/g), ...src.matchAll(/_COLUMNS = "([^"]*)"/g)].map((m) => m[1]);
    expect(selects.length).toBeGreaterThan(5);
    for (const s of selects) expect(s).not.toMatch(/access_code|phone|email|\*/);
    expect(src).toMatch(/from\("players"\)\.select\("id, full_name, player_order"\)\.eq\("team_id", coach\.teamId\)/);
  });
});

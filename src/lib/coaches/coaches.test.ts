import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { coachLink, coachReaches, coachSideOf, drawLabel, landingFrom, opponentsShown, orientScore, parseCoachLink, resultFor, teamsNeedingCodes, coachCodesNotice, tieStageLabel } from "./rules";
import { COACH_TOKEN_PREFIX, coachSecret, isCoachTokenShaped, signCoachToken, verifyCoachToken, type CoachTokenPayload } from "./token";
import { coachLineup, coachTieResult, coachTieSoon } from "./alerts";
import { formatEventCode, generateEventCode, hashEventCode, normalizeEventCode, openEventCode, sealEventCode } from "../orgs/codes";
import { isStaffTokenShaped, signStaffToken, verifyStaffToken } from "../auth/staffToken";
import { can, staffCan } from "../auth";
import type { MScore } from "../mobile/contract";

process.env.AUTH_SECRET ??= "test-auth-secret-for-vitest-only-0123456789";

const ORG = "11111111-1111-4111-8111-111111111111";
const EGY = "33333333-3333-4333-8333-333333333333";
const FRA = "44444444-4444-4444-8444-444444444444";
const ESP = "55555555-5555-4555-8555-555555555555";
const CODE = "c1111111-1111-4111-8111-111111111111";
const SES = "b1111111-1111-4111-8111-111111111111";
const SECRET = "k".repeat(40);
const NOW = Date.parse("2026-11-02T08:00:00Z");

const payload = (over: Partial<CoachTokenPayload> = {}): CoachTokenPayload => ({ v: 1, k: "coach", c: CODE, o: ORG, tm: EGY, s: SES, iat: NOW, exp: NOW + 3600_000, ...over });

describe("coach codes: random, hashed, sealed like event codes", () => {
  it("a code is 12 symbols of the code alphabet, hashed with the pepper, never stored plain", () => {
    const code = generateEventCode();
    expect(normalizeEventCode(formatEventCode(code).toLowerCase())).toBe(code);
    const h = hashEventCode(code, "p".repeat(40));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(code);
    expect(hashEventCode(code, "q".repeat(40))).not.toBe(h);
  });
  it("the sealed copy reopens only with the same pepper (reprinting a card)", () => {
    const code = generateEventCode();
    const sealed = sealEventCode(code, "p".repeat(40));
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain(code);
    expect(openEventCode(sealed, "p".repeat(40))).toBe(code);
    expect(openEventCode(sealed, "q".repeat(40))).toBeNull();
  });
});

describe("coach tokens", () => {
  it("round-trip with the coach key", () => {
    const t = signCoachToken(payload(), SECRET);
    expect(t.startsWith(COACH_TOKEN_PREFIX)).toBe(true);
    expect(isCoachTokenShaped(t)).toBe(true);
    expect(verifyCoachToken(t, SECRET, NOW + 1000)).toMatchObject({ c: CODE, o: ORG, tm: EGY, s: SES });
  });
  it("refuse a tampered, expired, foreign-key or malformed token", () => {
    const t = signCoachToken(payload(), SECRET);
    const [pre, body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...payload(), tm: FRA })).toString("base64url");
    expect(verifyCoachToken(`${pre}.${forged}.${sig}`, SECRET, NOW)).toBeNull();
    expect(verifyCoachToken(`${pre}.${body}.${sig}x`, SECRET, NOW)).toBeNull();
    expect(verifyCoachToken(t, SECRET, NOW + 3600_001)).toBeNull();
    expect(verifyCoachToken(t, "z".repeat(40), NOW)).toBeNull();
    expect(verifyCoachToken(signCoachToken(payload({ exp: NOW + 9 * 86_400_000 }), SECRET), SECRET, NOW)).toBeNull();
    expect(verifyCoachToken(signCoachToken(payload({ tm: "egypt" }), SECRET), SECRET, NOW)).toBeNull();
  });
  it("a coach token is never a staff token, and a staff token never a coach's", () => {
    const coach = signCoachToken(payload(), SECRET);
    expect(isStaffTokenShaped(coach)).toBe(false);
    expect(verifyStaffToken(coach, SECRET, NOW)).toBeNull();
    const staff = signStaffToken({ v: 1, k: "c", c: CODE, o: ORG, r: "referee", t: null, iat: NOW, exp: NOW + 3600_000 }, SECRET);
    expect(isCoachTokenShaped(staff)).toBe(false);
    expect(verifyCoachToken(staff, SECRET, NOW)).toBeNull();
  });
  it("the coach key is its own (derived), not the staff secret", () => {
    const env = { STAFF_SESSION_SECRET: "x".repeat(40) };
    expect(coachSecret(env)).not.toBe(env.STAFF_SESSION_SECRET);
    expect(coachSecret(env)).toBe(coachSecret(env));
  });
});

describe("what a coach reaches", () => {
  const tie = { team_a_id: EGY, team_b_id: FRA };
  it("only ties and matches their team plays in", () => {
    expect(coachSideOf(EGY, tie)).toBe("A");
    expect(coachSideOf(FRA, tie)).toBe("B");
    expect(coachSideOf(ESP, tie)).toBeNull();
    expect(coachReaches(EGY, tie)).toBe(true);
    expect(coachReaches(ESP, tie)).toBe(false);
    expect(coachReaches(EGY, null)).toBe(false);
    expect(coachReaches("", { team_a_id: null, team_b_id: null })).toBe(false);
  });
  it("the opponents' players once the rubber is under way", () => {
    for (const s of ["scheduled", "ready", "cancelled"]) expect(opponentsShown(s), s).toBe(false);
    for (const s of ["live", "paused", "completed", "retired", "walkover"]) expect(opponentsShown(s), s).toBe(true);
  });

  it("the opponents' players as soon as the line-ups are confirmed (published), not before", () => {
    for (const s of ["scheduled", "ready"]) {
      expect(opponentsShown(s, false), `${s}, not confirmed`).toBe(false);
      expect(opponentsShown(s, true), `${s}, confirmed`).toBe(true);
    }
    for (const s of ["live", "completed"]) expect(opponentsShown(s, true), s).toBe(true);
  });
  it("scores read our team first", () => {
    const score: MScore = { sets: [{ a: 6, b: 4, tb: null }, { a: 6, b: 7, tb: { a: 5, b: 7 } }], games: { a: 1, b: 3 }, points: { a: "15", b: "40" }, tiebreak: false, serving: "A", setsWon: { a: 1, b: 1 }, lastEventNumber: 9, lastUndo: 0, updatedAt: null };
    expect(orientScore(score, "A")).toBe(score);
    const b = orientScore(score, "B")!;
    expect(b.sets[0]).toMatchObject({ a: 4, b: 6 });
    expect(b.sets[1].tb).toEqual({ a: 7, b: 5 });
    expect(b.games).toEqual({ a: 3, b: 1 });
    expect(b.points).toEqual({ a: "40", b: "15" });
    expect(b.serving).toBe("B");
    expect(orientScore(null, "B")).toBeNull();
    expect(resultFor(EGY, EGY)).toBe("us");
    expect(resultFor(EGY, FRA)).toBe("them");
    expect(resultFor(EGY, null)).toBeNull();
  });
  it("names the stage, the Cup and the Plate", () => {
    expect(drawLabel(1, 8)).toBe("Cup · places 1–8");
    expect(drawLabel(9, 16)).toBe("Plate · places 9–16");
    expect(tieStageLabel({ stage: "group", round_name: null, draw_from: null, draw_to: null, places_from: null, places_to: null }, "A")).toBe("Group A");
    expect(tieStageLabel({ stage: "placement", round_name: "Semi-final", draw_from: 1, draw_to: 8, places_from: null, places_to: null }, null)).toBe("Cup · places 1–8 · Semi-final");
    expect(landingFrom("qualified", [{ from: 1, to: 8 }, { from: 9, to: 16 }])).toBe("Cup · places 1–8");
    expect(landingFrom("plate", [{ from: 1, to: 8 }, { from: 9, to: 16 }])).toBe("Plate · places 9–16");
    expect(landingFrom("pending", [])).toBeNull();
  });
  it("the card's link carries the code in the #fragment", () => {
    const link = coachLink("https://tour.mbeg.org/", "K7QM-W3XT-9HRP");
    expect(link).toBe("https://tour.mbeg.org/c#K7QM-W3XT-9HRP");
    expect(parseCoachLink(link)).toBe("K7QM-W3XT-9HRP");
    expect(parseCoachLink("movescore://c#K7QMW3XT9HRP")).toBe("K7QMW3XT9HRP");
    expect(parseCoachLink("https://tour.mbeg.org/r#K7QM-W3XT-9HRP")).toBeNull();
    expect(parseCoachLink("https://tour.mbeg.org/coach#K7QM-W3XT-9HRP")).toBeNull();
    expect(parseCoachLink("https://tour.mbeg.org/c?code=K7QM-W3XT-9HRP")).toBeNull();
  });
});

describe("coach alerts name their own team only", () => {
  const us = { teamId: EGY, code: "EGY" };
  it("a line-up alert lists our players, never the opponents'", () => {
    const p = coachLineup({ us, them: "FRA", tieId: "t1", rubbers: [{ label: "No. 2 singles", players: ["Ali A"] }, { label: "No. 1 singles", players: ["Omar B"] }, { label: "Doubles", players: [] }], late: false });
    expect(p.title).toBe("Line-up entered: EGY v FRA");
    expect(p.body).toBe("No. 2 singles: Ali A · No. 1 singles: Omar B");
    expect(p.targets).toEqual([{ kind: "coach_team", key: EGY }]);
    expect(p.url).toBe("movescore://coach/tie/t1");
  });
  it("tie soon and tie result read from our side", () => {
    expect(coachTieSoon({ us, them: "FRA", tieId: "t1", court: "Court 1", at: "2026-11-02T07:30:00Z", timeZone: "Africa/Cairo", stage: "Group A" }).body).toBe("Court 1 at 09:30 · Group A");
    expect(coachTieResult({ us, them: "FRA", tieId: "t1", won: false, rubbers: "1–2", stage: "Group A" }).title).toBe("EGY lost to FRA 1–2");
  });
});

describe("permissions: admins make coach codes, nobody else", () => {
  it("manage_coaches is the admins' (and owners') only", () => {
    expect(can("admin", "manage_coaches")).toBe(true);
    expect(can("owner", "manage_coaches")).toBe(true);
    for (const r of ["manager", "referee", "operator"] as const) expect(can(r, "manage_coaches"), r).toBe(false);
    expect(staffCan({ kind: "code", role: "referee", referee: { role: "master_referee" } }, "manage_coaches")).toBe(false);
  });
});

/* ---------------- source scans ---------------- */

const APP = join(__dirname, "..", "..", "app");
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
}

describe("every coach route and page checks the coach itself", () => {
  const routes = walk(join(APP, "api", "mobile", "v1", "coach")).filter((p) => p.endsWith("route.ts"));
  it("finds the coach routes", () => expect(routes.length).toBeGreaterThanOrEqual(6));
  for (const p of routes) {
    const r = relative(APP, p);
    if (r.endsWith("coach/session/route.ts")) continue; // signs in (rate-limited) or out
    it(r, () => {
      const text = readFileSync(p, "utf8");
      expect(text, `${r} must start with coachRoute()`).toMatch(/coachRoute\(\)/);
      expect(text, `${r} is read only`).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
      expect(text, `${r} never reaches staff guards or data directly`).not.toMatch(/staffRoute\(|db\(\)/);
    });
  }
  const pages = walk(join(APP, "coach")).filter((p) => p.endsWith("page.tsx") && !p.endsWith(join("coach", "page.tsx")));
  for (const p of pages) {
    it(relative(APP, p), () => expect(readFileSync(p, "utf8")).toMatch(/currentCoachResolution\(\)/));
  }
});

describe("the coach server never selects private columns", () => {
  const src = readFileSync(join(__dirname, "server.ts"), "utf8");
  const selects = [...src.matchAll(/\.select\(([^)]*)\)/g)].map((m) => m[1]);
  it("selects with explicit columns (or standings, which hold results only)", () => {
    for (const s of selects) {
      if (s.includes('"*"')) expect(src.slice(src.indexOf(s) - 120, src.indexOf(s)), "only standings_snapshots may be read whole").toMatch(/standings_snapshots/);
    }
  });
  it("no access codes, phones, emails, notes or referee names", () => {
    for (const s of selects) expect(s, s).not.toMatch(/access_code|phone|email|notes|referee|captain/);
    for (const c of ["TEAM_COLUMNS", "RUBBER_COLUMNS", "TIE_COLUMNS", "CODE_COLUMNS"]) {
      const m = new RegExp(`const ${c} =\\s*"([^"]+)"`).exec(src);
      expect(m, c).not.toBeNull();
      expect(m![1]).not.toMatch(/access_code|phone|email|notes|captain|code_hash/);
    }
  });
});

describe("coach codes made when the draw is confirmed (idempotent)", () => {
  const now = Date.parse("2026-10-30T10:00:00Z");
  const later = "2026-11-08T21:59:00Z";
  const teams = Array.from({ length: 16 }, (_, i) => ({ id: `t${i}`, team_status: i === 15 ? "withdrawn" : "active" }));
  it("the first draw: a code for every team that plays (a withdrawn team gets none)", () => {
    const r = teamsNeedingCodes(teams, [], now);
    expect(r.create.map((t) => t.id)).toEqual(teams.slice(0, 15).map((t) => t.id));
    expect(r.stale).toEqual([]);
  });
  it("a second run with every code working makes none", () => {
    const codes = teams.slice(0, 15).map((t, i) => ({ id: `c${i}`, team_id: t.id, revoked_at: null, expires_at: later }));
    expect(teamsNeedingCodes(teams, codes, now).create).toEqual([]);
  });
  it("only the team added later gets one; a revoked code does not count, an expired one is retired first", () => {
    const codes = [
      ...teams.slice(0, 12).map((t, i) => ({ id: `c${i}`, team_id: t.id, revoked_at: null, expires_at: later })),
      { id: "rev", team_id: "t12", revoked_at: "2026-10-29T10:00:00Z", expires_at: later },
      { id: "old", team_id: "t13", revoked_at: null, expires_at: "2026-10-01T00:00:00Z" },
    ];
    const r = teamsNeedingCodes([...teams, { id: "late", team_status: "active" }], codes, now);
    expect(r.create.map((t) => t.id)).toEqual(["t12", "t13", "t14", "late"]);
    expect(r.stale).toEqual(["old"]);
  });
  it("the admin's notice", () => {
    expect(coachCodesNotice(16)).toBe("Coach codes created for 16 teams — print the cards");
    expect(coachCodesNotice(1)).toBe("Coach codes created for 1 team — print the cards");
    expect(coachCodesNotice(0)).toBeNull();
  });
  it("never two codes for one team in one run", () => {
    expect(teamsNeedingCodes([{ id: "a", team_status: null }, { id: "a", team_status: null }], [], now).create).toHaveLength(1);
  });
  it("the draw hooks it: generateGroupTies makes the codes, the ties page shows the notice", () => {
    const tieOps = readFileSync(join(__dirname, "..", "tennis", "tieOps.ts"), "utf8");
    expect(tieOps).toMatch(/coachCodesOnDraw\(tournamentId, actorRole\)/);
    const page = readFileSync(join(__dirname, "..", "..", "app", "admin", "tournaments", "[id]", "ties", "page.tsx"), "utf8");
    expect(page).toContain("coach-codes-notice");
  });
});

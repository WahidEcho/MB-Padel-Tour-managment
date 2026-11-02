import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_TENNIS_SCORING_CONFIG } from "../types";
import { parseSmashSchedule, type SmashSchedule } from "./feed";
import { nameKey, OWN_COURTS, planImport, smashImportSwitch, type OurSide } from "./plan";

/** Recorded from Smash's public feed on 2 Nov 2026 (the first day of the Cairo events). */
const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8")) as unknown;
const endOfDay = () => parseSmashSchedule(fixture("2026-11-02-end-of-day.json"));
const midday = () => parseSmashSchedule(fixture("2026-11-02-midday.json"));

const BJK_COURTS = new Set([1, 2, 3, 4, 5, 6, 14, 16]);

/**
 * Our side as it was loaded for the day: one tie per court between Smash's two nations, singles
 * named S2 then S1 in Smash's order, the doubles pair named, nothing scored yet.
 */
function oursFrom(smash: SmashSchedule): OurSide {
  const ours: OurSide = {
    events: [
      { id: "bjk", slug: "bjk-cup-junior-finals-2026", sport: "tennis", scoring_config: DEFAULT_TENNIS_SCORING_CONFIG },
      { id: "dc", slug: "davis-cup-junior-finals-2026", sport: "tennis", scoring_config: DEFAULT_TENNIS_SCORING_CONFIG },
    ],
    courts: [],
    teams: [],
    players: [],
    ties: [],
    rubbers: [],
  };
  const team = (tid: string, code: string) => {
    let t = ours.teams.find((x) => x.tournamentId === tid && x.code === code);
    if (!t) ours.teams.push((t = { id: `${tid}-${code}`, tournamentId: tid, code }));
    return t.id;
  };
  const player = (teamId: string, name: string) => {
    let p = ours.players.find((x) => x.teamId === teamId && x.name === name);
    if (!p) ours.players.push((p = { id: `${teamId}-${nameKey(name).replace(/ /g, "-")}`, teamId, name }));
    return p.id;
  };
  for (const court of [...new Set(smash.matches.map((m) => m.court))]) {
    const tid = BJK_COURTS.has(court) ? "bjk" : "dc";
    const courtId = `${tid}-court-${court}`;
    ours.courts.push({ id: courtId, tournamentId: tid, name: `Court ${court}` });
    const ms = smash.matches.filter((m) => m.court === court);
    const [p1, p2] = ms[0].sides;
    const a = team(tid, p1.code);
    const b = team(tid, p2.code);
    const tieId = `tie-${court}`;
    ours.ties.push({ id: tieId, tournamentId: tid, courtId, scheduledTime: "2026-11-02T07:30:00Z", teamA: a, teamB: b, roundName: "Group A" });
    let singles = 0;
    for (const m of ms) {
      const rubberType = m.type === "doubles" ? "D" : singles++ === 0 ? "S2" : "S1";
      ours.rubbers.push({
        id: `${tieId}-${rubberType}`,
        tournamentId: tid,
        tieId,
        rubberType,
        stage: "group",
        status: "scheduled",
        teamA: a,
        teamB: b,
        aPlayerIds: m.sides[0].names.map((n) => player(a, n)),
        bPlayerIds: m.sides[1].names.map((n) => player(b, n)),
        lastEventNumber: 0,
        hasEvents: false,
      });
    }
  }
  return ours;
}

const rubberOf = (ours: OurSide, court: number, type: string) => ours.rubbers.find((r) => r.tieId === `tie-${court}` && r.rubberType === type)!;

describe("parseSmashSchedule", () => {
  it("reads every match of the recorded day, with its Cairo day", () => {
    const s = endOfDay();
    expect(s.matches).toHaveLength(48);
    expect(s.matches.filter((m) => m.status === "completed")).toHaveLength(47);
    // A "followed by" match has no scheduled time; it is dated by when it was played.
    const followed = s.matches.find((m) => m.court === 1 && m.order === 2)!;
    expect(followed.day).toBe("2026-11-02");
    expect(followed.sides.map((x) => x.code)).toEqual(["COL", "AUS"]);
    const doubles = s.matches.find((m) => m.court === 1 && m.type === "doubles")!;
    expect(doubles.sides[0].names).toEqual(["Alicia LONDONO", "Laura Valentina VILLAMIL ARIAS"]);
  });

  it("refuses something that is not the schedule", () => {
    expect(() => parseSmashSchedule({ error: "down" })).toThrow();
    expect(() => parseSmashSchedule(null)).toThrow();
  });
});

describe("planImport on the recorded day", () => {
  it("enters the clean results, sends the doubtful ones to the desk and never touches courts 13 and 14", () => {
    const smash = endOfDay();
    const plan = planImport(smash, oursFrom(smash));
    expect(plan.enter).toHaveLength(36);
    expect(plan.desk).toHaveLength(5);
    expect(plan.skipped).toHaveLength(6);
    expect(plan.skipped.every((s) => OWN_COURTS.has(s.court) && s.why === "court scored on Move Score")).toBe(true);
    expect(plan.enter.some((e) => OWN_COURTS.has(e.court))).toBe(false);
    expect(plan.desk.some((e) => OWN_COURTS.has(e.court))).toBe(false);
    // Court 11's doubles was not finished on Smash: not listed at all.
    expect([...plan.enter, ...plan.desk, ...plan.skipped].some((x) => x.court === 11 && x.smash.startsWith("doubles"))).toBe(false);
    // Desk: 7-6 sets with no tie-break points (court 1 D, court 8 D, court 16 S1 and D) and 0-0 ones (court 15).
    expect(plan.desk.map((d) => `${d.court} ${d.ours}`).sort()).toEqual(
      ["1 BJK Group A COL v AUS D", "15 DC Group A USA v IND S2", "16 BJK Group A GBR v BRA D", "16 BJK Group A GBR v BRA S1", "8 DC Group A BRA v MAR D"].sort(),
    );
    expect(plan.desk.every((d) => /no tie-break points/.test(d.why))).toBe(true);
  });

  it("never imports court 13 or 14, even with everything matching and nothing scored", () => {
    const smash = endOfDay();
    const ours = oursFrom(smash);
    const plan = planImport(smash, ours);
    for (const c of [13, 14]) {
      expect(plan.enter.filter((e) => e.court === c)).toHaveLength(0);
      expect(plan.skipped.filter((e) => e.court === c)).toHaveLength(3);
    }
    // The same data on another court number would be entered: the court is the only reason.
    expect(planImport(smash, ours, { ownCourts: new Set() }).enter.filter((e) => e.court === 13)).toHaveLength(3);
  });

  it("skips a rubber that already has any score on Move Score", () => {
    const smash = endOfDay();
    const ours = oursFrom(smash);
    rubberOf(ours, 2, "S2").status = "completed";
    rubberOf(ours, 2, "S1").lastEventNumber = 4;
    rubberOf(ours, 2, "D").hasEvents = true;
    rubberOf(ours, 3, "S2").status = "live";
    const plan = planImport(smash, ours);
    expect(plan.enter.filter((e) => e.court === 2)).toHaveLength(0);
    expect(plan.skipped.filter((e) => e.court === 2).map((e) => e.why).sort()).toEqual(["already completed on Move Score", "already has a score on Move Score", "already has a score on Move Score"]);
    expect(plan.skipped.find((e) => e.court === 3)?.why).toBe("already live on Move Score");
    expect(plan.enter).toHaveLength(32);
  });

  it("sends a 7-6 set with no tie-break points, or 0-0 ones, to the desk and enters real ones", () => {
    const smash = endOfDay();
    const plan = planImport(smash, oursFrom(smash));
    expect(plan.desk.find((d) => d.court === 1)?.why).toMatch(/set 1 is 7-6 with no tie-break points/);
    expect(plan.desk.find((d) => d.court === 15)?.why).toMatch(/set 1 is 6-7 with no tie-break points/);
    // Court 8 S1: 6-4 6-7(4) 6-0, the tie-break points given by Smash.
    const c8 = plan.enter.find((e) => e.court === 8 && e.ours?.endsWith("S1"))!;
    expect(c8.payload.sets).toEqual([{ a: 6, b: 4 }, { a: 6, b: 7, tb: { a: 4, b: 7 } }, { a: 6, b: 0 }]);
    expect(c8.why).toBe("6-4 6-7(4) 6-0");
  });

  it("enters a 7-6 set once Smash adds its tie-break points later, and never takes [0,0] as a score", () => {
    const smash = endOfDay();
    const ours = oursFrom(smash);
    const c1 = smash.matches.find((m) => m.court === 1 && m.type === "doubles")!;
    expect(planImport(smash, ours).desk.some((d) => d.smashId === c1.id)).toBe(true);
    // A later snapshot: Smash wrote the first set's tie-break as [7, 4].
    c1.tiebreaks = [[7, 4], null, null];
    const later = planImport(smash, ours).enter.find((e) => e.smashId === c1.id)!;
    expect(later.payload.sets).toEqual([{ a: 7, b: 6, tb: { a: 7, b: 4 } }, { a: 4, b: 6 }, { a: 1, b: 0, tb: { a: 10, b: 6 } }]);
    expect(later.why).toBe("7-6(4) 4-6 [10-6]");
    // [0, 0] is the same as nothing.
    c1.tiebreaks = [[0, 0], null, null];
    expect(planImport(smash, ours).desk.find((d) => d.smashId === c1.id)?.why).toMatch(/no tie-break points/);
  });

  it("turns the sets round when Smash's player 1 is our side B", () => {
    const smash = endOfDay();
    const ours = oursFrom(smash);
    const straight = planImport(smash, ours).enter.find((e) => e.court === 7 && e.ours?.endsWith("S2"))!;
    // Our tie on court 7 written HUN v ESP: side A is Smash's player 2.
    const tie = ours.ties.find((t) => t.id === "tie-7")!;
    [tie.teamA, tie.teamB] = [tie.teamB, tie.teamA];
    for (const r of ours.rubbers.filter((x) => x.tieId === "tie-7")) {
      [r.teamA, r.teamB] = [r.teamB, r.teamA];
      [r.aPlayerIds, r.bPlayerIds] = [r.bPlayerIds, r.aPlayerIds];
    }
    const turned = planImport(smash, ours).enter.find((e) => e.court === 7 && e.ours?.endsWith("S2"))!;
    expect(straight.payload.sets).toEqual([{ a: 4, b: 6 }, { a: 6, b: 4 }, { a: 6, b: 7, tb: { a: 4, b: 7 } }]);
    expect(turned.payload.sets).toEqual([{ a: 6, b: 4 }, { a: 4, b: 6 }, { a: 7, b: 6, tb: { a: 7, b: 4 } }]);
    // Hungary (Fazekas) won either way.
    expect(straight.winnerTeamId).toBe("dc-HUN");
    expect(turned.winnerTeamId).toBe("dc-HUN");
    expect(turned.ours).toBe("DC Group A HUN v ESP S2");
  });

  it("maps doubles to the D rubber, with the match tie-break Smash writes as points", () => {
    const smash = endOfDay();
    const plan = planImport(smash, oursFrom(smash));
    const d7 = plan.enter.find((e) => e.court === 7 && e.ours?.endsWith(" D"))!;
    expect(d7.matchId).toBe("tie-7-D");
    expect(d7.payload.sets).toEqual([{ a: 2, b: 6 }, { a: 7, b: 5 }, { a: 0, b: 1, tb: { a: 8, b: 10 } }]);
    expect(d7.winnerTeamId).toBe("dc-HUN");
    expect(d7.why).toBe("2-6 7-5 [8-10]");
    // 4-6 7-6(1) [10-4] on court 10.
    expect(plan.enter.find((e) => e.court === 10 && e.ours?.endsWith(" D"))?.why).toBe("4-6 7-6(1) [10-4]");
  });

  it("sends a doubles pair that differs from our line-up, or one not named yet, to the desk", () => {
    const smash = endOfDay();
    const ours = oursFrom(smash);
    const d = rubberOf(ours, 2, "D");
    d.aPlayerIds = [d.aPlayerIds![0], "someone-else"];
    rubberOf(ours, 3, "D").bPlayerIds = null;
    const plan = planImport(smash, ours);
    expect(plan.desk.find((x) => x.court === 2)?.why).toMatch(/doubles pair differs/);
    expect(plan.desk.find((x) => x.court === 3)?.why).toMatch(/doubles pair differs/);
  });

  it("sends a singles player we do not have in that rubber to the desk", () => {
    const smash = endOfDay();
    const ours = oursFrom(smash);
    const s2 = rubberOf(ours, 4, "S2");
    const s1 = rubberOf(ours, 4, "S1");
    // Our S1 names the S2 players again: Smash's first singles fits both, its second fits neither.
    s1.aPlayerIds = s2.aPlayerIds;
    s1.bPlayerIds = s2.bPlayerIds;
    const plan = planImport(smash, ours);
    expect(plan.desk.filter((x) => x.court === 4).map((x) => x.why)).toEqual([
      "more than one singles rubber fits in BJK Group A ROU v CAN",
      "no singles rubber in BJK Group A ROU v CAN with these players (line-up differs or not named?)",
    ]);
  });

  it("finds no tie on another day, or on another court, and refuses to choose between two", () => {
    const smash = endOfDay();
    const ours = oursFrom(smash);
    ours.ties.find((t) => t.id === "tie-5")!.scheduledTime = "2026-11-03T07:30:00Z";
    ours.ties.find((t) => t.id === "tie-6")!.courtId = "bjk-court-1";
    ours.ties.push({ ...ours.ties.find((t) => t.id === "tie-9")!, id: "tie-9-again" });
    const plan = planImport(smash, ours);
    expect(plan.desk.filter((x) => x.court === 5).every((x) => x.why === "no CZE v TPE tie on Court 5 on 2026-11-02")).toBe(true);
    expect(plan.desk.filter((x) => x.court === 6).every((x) => x.why.startsWith("no USA v SVK tie on Court 6"))).toBe(true);
    expect(plan.desk.filter((x) => x.court === 9).every((x) => x.why.startsWith("2 JPN v VEN ties"))).toBe(true);
    expect(plan.enter.some((e) => [5, 6, 9].includes(e.court))).toBe(false);
  });

  it("sends retirements, walkovers and a winner the sets do not give to the desk", () => {
    const smash = endOfDay();
    const ours = oursFrom(smash);
    const at = (court: number, order: number) => smash.matches.find((m) => m.court === court && m.order === order)!;
    at(2, 1).retired = true;
    at(3, 1).walkover = true;
    at(4, 1).winner = 2; // ROU won 6-0 7-5
    at(6, 1).sets = [[6, 2], [5, 7]]; // not finished
    const plan = planImport(smash, ours);
    expect(plan.desk.find((x) => x.court === 2)?.why).toMatch(/retired/);
    expect(plan.desk.find((x) => x.court === 3)?.why).toMatch(/walkover/);
    expect(plan.desk.find((x) => x.court === 4)?.why).toMatch(/winner Smash names does not match/);
    expect(plan.desk.find((x) => x.court === 6)?.why).toMatch(/not a finished score/);
  });

  it("a court in neither event is the desk's", () => {
    const smash = endOfDay();
    const ours = oursFrom(smash);
    ours.courts = ours.courts.filter((c) => c.name !== "Court 12");
    expect(planImport(smash, ours).desk.filter((x) => x.court === 12).map((x) => x.why)).toEqual(Array(3).fill("Court 12 is in neither event"));
  });

  it("lists only finished matches in the middle of the day", () => {
    const smash = midday();
    const plan = planImport(smash, oursFrom(smash));
    const listed = plan.enter.length + plan.desk.length + plan.skipped.length;
    expect(listed).toBe(smash.matches.filter((m) => m.status === "completed").length);
    expect(plan.enter.some((e) => OWN_COURTS.has(e.court))).toBe(false);
  });

  it("names match without accents, case or word order", () => {
    expect(nameKey("Thomas O'NEILL")).toBe(nameKey("thomas o neill"));
    expect(nameKey("Fatima RAMI JAMAL AL-DEEN")).toBe(nameKey("Al Deen Fatima Rami Jamal"));
    expect(nameKey("Zoë Müller")).toBe(nameKey("ZOE MULLER"));
  });
});

describe("smashImportSwitch", () => {
  const before = new Date("2026-11-08T18:59:00Z");
  const after = new Date("2026-11-08T19:00:00Z");
  it("is off unless SMASH_IMPORT_ON=1", () => {
    expect(smashImportSwitch({}, before).on).toBe(false);
    expect(smashImportSwitch({ SMASH_IMPORT_ON: "true" }, before).on).toBe(false);
    expect(smashImportSwitch({ SMASH_IMPORT_ON: "1" }, before).on).toBe(true);
  });
  it("stops by itself at 21:00 Cairo on 8 Nov 2026, unless SMASH_IMPORT_UNTIL says otherwise", () => {
    expect(smashImportSwitch({ SMASH_IMPORT_ON: "1" }, after).on).toBe(false);
    expect(smashImportSwitch({ SMASH_IMPORT_ON: "1", SMASH_IMPORT_UNTIL: "2026-11-09T21:00:00+02:00" }, after).on).toBe(true);
    expect(smashImportSwitch({ SMASH_IMPORT_ON: "1", SMASH_IMPORT_UNTIL: "2026-11-05T12:00:00Z" }, before).on).toBe(false);
    expect(smashImportSwitch({ SMASH_IMPORT_ON: "1", SMASH_IMPORT_UNTIL: "not a date" }, after).on).toBe(false);
  });
});

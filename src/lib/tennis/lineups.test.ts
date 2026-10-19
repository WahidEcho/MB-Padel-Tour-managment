import { describe, expect, it } from "vitest";
import { changedRubbers, checkLineup, exceptionLine, issueText, lineupStep, needsReason, unaccepted, warningsForChange, type LineupDraft } from "./lineupRules";
import { checkRow, draftFromRow, editDistance, eventLabel, findTie, matchPlayer, normName, previewSheet, readSheet, sheetDay, type SheetRow, type SheetTie } from "./lineupSheet";
import { ITF_REGULATIONS_URL, ITF_TEAM_REGULATIONS, regulationLabel, regulationPath } from "./regulations";

const squad = [
  { id: "ali", name: "Ali Hassan" },
  { id: "omar", name: "Omar Fathy" },
  { id: "karim", name: "Karim Saleh" },
  { id: "youssef", name: "Youssef Hassan" },
];
const L = (S1: string | null, S2: string | null, D: (string | null)[] = [null, null]): LineupDraft => ({ S1, S2, D });

describe("line-up checks: problems refuse, warnings need accepting", () => {
  it("a good line-up has neither", () => {
    expect(checkLineup(L("ali", "omar", ["karim", "youssef"]), squad)).toEqual({ problems: [], warnings: [] });
  });
  it("problems: missing singles, one player in both singles, outsiders, half a doubles pair", () => {
    expect(checkLineup(L(null, null), squad).problems.map((p) => p.code)).toEqual(["missing_s1", "missing_s2"]);
    expect(checkLineup(L("ali", "ali"), squad).problems.map((p) => p.code)).toEqual(["same_singles"]);
    expect(checkLineup(L("ali", "stranger"), squad).problems.map((p) => p.code)).toEqual(["not_in_squad"]);
    expect(checkLineup(L("ali", "omar", ["karim", null]), squad).problems.map((p) => p.code)).toEqual(["doubles_incomplete"]);
    expect(checkLineup(L("ali", "omar", ["karim", "karim"]), squad).problems.map((p) => p.code)).toEqual(["doubles_same"]);
  });
  it("a doubles-only step does not ask for the singles", () => {
    expect(checkLineup(L(null, null, ["ali", "omar"]), squad, { requireSingles: false }).problems).toEqual([]);
  });
  it("order of merit (Reg 43): a warning in plain words, with names and ranks", () => {
    const c = checkLineup(L("omar", "ali"), squad);
    expect(c.problems).toEqual([]);
    expect(c.warnings).toHaveLength(1);
    const w = c.warnings[0]!;
    expect(w).toMatchObject({ code: "order_of_merit", reg: "43", rubbers: ["S1", "S2"], key: "order_of_merit:omar>ali" });
    expect(w.message).toBe("Ali Hassan (No. 1) is ranked above Omar Fathy (No. 2), so Ali Hassan should play Singles 1.");
    expect(issueText(w)).toBe(`${w.message} ITF Reg. 43.`);
    expect(exceptionLine(w)).toBe("Omar Fathy plays Singles 1 above Ali Hassan (ITF Reg. 43)");
  });
  it("a retired player named again for a rubber still to play (Reg 50)", () => {
    const c = checkLineup(L("ali", "omar", ["omar", "karim"]), squad, { retired: ["omar"], open: ["D"] });
    expect(c.warnings.map((w) => [w.code, w.reg, w.rubbers])).toEqual([["retired_again", "50", ["D"]]]);
    expect(c.warnings[0]!.message).toContain("Omar Fathy retired earlier in this tie");
    // Named only in the finished singles: history, no warning.
    expect(checkLineup(L("ali", "omar"), squad, { retired: ["omar"], open: ["D"] }).warnings).toEqual([]);
  });
  it("a warning counts only when the change touches its rubbers (an earlier acceptance stands)", () => {
    const now = L("omar", "ali");
    const next = L("omar", "ali", ["karim", "youssef"]);
    const c = checkLineup(next, squad);
    expect(changedRubbers(now, next)).toEqual(["D"]);
    expect(warningsForChange(c, ["D"])).toEqual([]);
    expect(warningsForChange(c, ["S1"])).toHaveLength(1);
  });
  it("acceptances are matched by key, with or without the side", () => {
    const w = checkLineup(L("omar", "ali"), squad).warnings;
    expect(unaccepted(w, [], "A")).toHaveLength(1);
    expect(unaccepted(w, ["A:order_of_merit:omar>ali"], "A")).toHaveLength(0);
    expect(unaccepted(w, ["B:order_of_merit:omar>ali"], "A")).toHaveLength(1);
    expect(unaccepted(w, ["order_of_merit:omar>ali"])).toHaveLength(0);
  });
  it("a reason after the lock, except naming the doubles for the first time", () => {
    expect(needsReason(false, L("ali", "omar"), L("ali", "karim"))).toBe(false);
    expect(needsReason(true, L("ali", "omar"), L("ali", "karim"))).toBe(true);
    expect(needsReason(true, L("ali", "omar"), L("ali", "omar", ["ali", "karim"]))).toBe(false);
    expect(needsReason(true, L("ali", "omar", ["ali", "karim"]), L("ali", "omar", ["ali", "youssef"]))).toBe(true);
    expect(needsReason(true, L("ali", "omar"), L("ali", "omar"))).toBe(false);
  });
});

describe("the court referee's step", () => {
  const r = (S1: string, S2: string, D: string) => [
    { type: "S2" as const, status: S2 as never },
    { type: "S1" as const, status: S1 as never },
    { type: "D" as const, status: D as never },
  ];
  const none = { A: L(null, null), B: L(null, null) };
  const singles = { A: L("ali", "omar"), B: L("x", "y") };
  const all = { A: L("ali", "omar", ["ali", "karim"]), B: L("x", "y", ["x", "z"]) };
  it("singles before the tie, the doubles after the singles, then done", () => {
    expect(lineupStep(r("scheduled", "scheduled", "scheduled"), none)).toBe("singles");
    expect(lineupStep(r("scheduled", "live", "scheduled"), singles)).toBe("doubles_later");
    expect(lineupStep(r("completed", "retired", "scheduled"), singles)).toBe("doubles");
    expect(lineupStep(r("completed", "completed", "scheduled"), all)).toBe("done");
    expect(lineupStep(r("completed", "completed", "live"), singles)).toBe("done");
  });
});

describe("the line-up sheet", () => {
  const head = ["Day", "Event", "Court", "Time", "Nation A", "Nation B", "S1 A", "S1 B", "S2 A", "S2 B", "D A1", "D A2", "D B1", "D B2"];
  it("finds the header row anywhere in the top rows, in any column order", () => {
    const grid = [["Move Score line-ups"], [], ["Nation B", "Nation A", "S1 A", "S1 B", "S2 A", "S2 B", "Day", "Event"], ["USA", "EGY", "Ali", "Smith", "Omar", "Jones", "2026-11-02", "Boys"], [null, null]];
    const { rows, error } = readSheet(grid);
    expect(error).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ line: 4, nationA: "EGY", nationB: "USA", s1a: "Ali", s2b: "Jones", day: "2026-11-02", event: "Boys", da1: "" });
  });
  it("says what is wrong with a sheet that is not the template", () => {
    expect(readSheet([["Name", "Score"]]).error).toMatch(/No header row/);
    expect(readSheet([["Day", "Event", "Court", "Time", "Nation A", "Nation B", "S1 A"]]).error).toMatch(/"S1 B"/);
    expect(readSheet([head]).error).toMatch(/no ties/);
  });
  it("normalises names: case, accents, punctuation", () => {
    expect(normName("  José  Ñúñez-Smith ")).toBe("jose nunez smith");
    expect(editDistance("hassan", "hasan")).toBe(1);
  });
  it("matches typed names: exact, close with suggestions, unknown", () => {
    expect(matchPlayer("ali hassan", squad)).toMatchObject({ status: "exact", id: "ali" });
    expect(matchPlayer("A. Hassan", squad)).toMatchObject({ status: "exact", id: "ali" });
    expect(matchPlayer("Hassan Ali", squad)).toMatchObject({ status: "exact", id: "ali" });
    expect(matchPlayer("Fathy", squad)).toMatchObject({ status: "exact", id: "omar" });
    expect(matchPlayer("No. 3", squad)).toMatchObject({ status: "exact", id: "karim" });
    expect(matchPlayer("", squad)).toMatchObject({ status: "empty", id: null });
    // Two Hassans: a last name alone is a close match with both offered.
    const hassan = matchPlayer("Hassan", squad);
    expect(hassan.status).toBe("close");
    expect(hassan.suggestions.map((p) => p.id).sort()).toEqual(["ali", "youssef"]);
    // A typo: close, the right player first.
    const typo = matchPlayer("Omar Fathi", squad);
    expect(typo).toMatchObject({ status: "close", id: "omar" });
    expect(matchPlayer("Karem Salih", squad)).toMatchObject({ status: "close", id: "karim" });
    expect(matchPlayer("Rafael Nadal", squad)).toMatchObject({ status: "unknown", id: null, suggestions: [] });
  });
  it("labels the Junior Finals' events Boys and Girls", () => {
    expect(eventLabel("Davis Cup Junior Finals 2026")).toBe("Boys");
    expect(eventLabel("Billie Jean King Cup Junior Finals 2026")).toBe("Girls");
    expect(eventLabel("Club Teams")).toBe("Club Teams");
  });
  it("reads days the way Cairo writes them", () => {
    expect(sheetDay("2/11/2026")).toBe("2026-11-02");
    expect(sheetDay("2026-11-02")).toBe("2026-11-02");
    expect(sheetDay("Monday")).toBeNull();
  });

  const usa = [{ id: "u1", name: "Sam Smith" }, { id: "u2", name: "Joe Jones" }, { id: "u3", name: "Max Miller" }];
  const tie = (over: Partial<SheetTie> = {}): SheetTie => ({
    id: "t1",
    tournamentId: "boys",
    event: "Boys",
    eventName: "Davis Cup Junior Finals",
    label: "EGY v USA",
    a: { teamId: "egy", code: "EGY", name: "Egypt" },
    b: { teamId: "usa", code: "USA", name: "United States" },
    court: "Court 1",
    day: "2026-11-02",
    time: "09:30",
    status: "scheduled",
    locked: false,
    rubbers: [{ type: "S2", status: "scheduled" }, { type: "S1", status: "scheduled" }, { type: "D", status: "scheduled" }],
    sides: { A: { squad, lineup: L(null, null), retired: [], open: ["S1", "S2", "D"] }, B: { squad: usa, lineup: L(null, null), retired: [], open: ["S1", "S2", "D"] } },
    ...over,
  });
  const row = (o: Partial<SheetRow>): SheetRow => ({ line: 2, day: "", event: "", court: "", time: "", nationA: "EGY", nationB: "USA", s1a: "", s1b: "", s2a: "", s2b: "", da1: "", da2: "", db1: "", db2: "", ...o });

  it("finds the tie by its nations in either order, by code or name", () => {
    expect(findTie(row({}), [tie()])).toMatchObject({ swapped: false });
    expect(findTie(row({ nationA: "United States", nationB: "Egypt" }), [tie()])).toMatchObject({ swapped: true });
    expect(findTie(row({ nationB: "JPN" }), [tie()])).toEqual({ error: "No tie EGY v JPN." });
    expect(findTie(row({ event: "Girls" }), [tie()])).toEqual({ error: 'No event called "Girls".' });
  });
  it("needs the event when the same pair plays in both", () => {
    const girls = tie({ id: "t2", tournamentId: "girls", event: "Girls", eventName: "Billie Jean King Cup Junior Finals" });
    expect(findTie(row({}), [tie(), girls])).toMatchObject({ error: expect.stringMatching(/Event column/) });
    expect(findTie(row({ event: "girls" }), [tie(), girls])).toMatchObject({ tie: { id: "t2" } });
  });
  it("previews a row: cells matched to the right nation even when swapped, notes on the order of play", () => {
    const [p] = previewSheet([row({ nationA: "USA", nationB: "EGY", court: "Court 3", s1a: "Smith", s1b: "Ali Hassan", s2a: "Jones", s2b: "Omar Fathi" })], [tie()]);
    expect(p!.error).toBeNull();
    expect(p!.swapped).toBe(true);
    expect(p!.cells["A.S1"]).toMatchObject({ status: "exact", id: "ali" });
    expect(p!.cells["B.S1"]).toMatchObject({ status: "exact", id: "u1" });
    expect(p!.cells["A.S2"]).toMatchObject({ status: "close", id: "omar" });
    expect(p!.notes).toEqual(["The order of play has this tie on Court 1, not Court 3."]);
  });
  it("the same tie twice is refused on the second row", () => {
    const rows = previewSheet([row({ line: 2 }), row({ line: 3 })], [tie()]);
    expect(rows[1]!.error).toBe("The same tie as row 2.");
  });
  it("checks a row as setLineup will: unknown names block, the order of merit warns, choices fix a cell", () => {
    const t = tie();
    const [p] = previewSheet([row({ s1a: "Omar Fathy", s2a: "Ali Hassan", s1b: "Smith", s2b: "Nobody Here" })], [t]);
    const c = checkRow(p!, t);
    expect(c.A.problems).toEqual([]);
    expect(c.A.warnings.map((w) => [w.code, w.key])).toEqual([["order_of_merit", "A:order_of_merit:omar>ali"]]);
    expect(c.B.problems.map((x) => x.code)).toEqual(["missing_s2"]);
    const fixed = checkRow(p!, t, { "B.S2": "u2" });
    expect(fixed.B.problems).toEqual([]);
    expect(fixed.B.draft).toEqual(L("u1", "u2", [null, null]));
  });
  it("empty cells leave a side (or the named doubles) as they are", () => {
    const t = tie({ sides: { ...tie().sides, B: { ...tie().sides.B, lineup: L("u1", "u2", ["u1", "u3"]) } } });
    const [p] = previewSheet([row({ s1a: "Ali", s2a: "Omar" })], [t]);
    expect(draftFromRow(p!, "B", t.sides.B.lineup)).toBeNull();
    const [q] = previewSheet([row({ s1b: "Smith", s2b: "Miller" })], [t]);
    expect(draftFromRow(q!, "B", t.sides.B.lineup)).toEqual(L("u1", "u3", ["u1", "u3"]));
  });
  it("a locked line-up's change is late (needs the reason); a started rubber cannot change", () => {
    const t = tie({ locked: true, sides: { ...tie().sides, A: { ...tie().sides.A, lineup: L("ali", "omar") } }, rubbers: [{ type: "S2", status: "live" }, { type: "S1", status: "scheduled" }, { type: "D", status: "scheduled" }] });
    const [p] = previewSheet([row({ s1a: "Ali", s2a: "Karim" })], [t]);
    const c = checkRow(p!, t);
    expect(c.A.late).toBe(true);
    expect(c.A.problems.map((x) => x.key)).toEqual(["under_way:S2"]);
  });
});

describe("regulation pages", () => {
  it("every regulation the checks name has our own summary and a path", () => {
    for (const reg of ["43", "46", "50"]) {
      expect(ITF_TEAM_REGULATIONS[reg]?.summary.length).toBeGreaterThan(0);
      expect(regulationPath(reg)).toBe(`/regulations/itf-junior-team/${reg}`);
    }
    expect(regulationLabel("43")).toBe("ITF Reg. 43");
    expect(ITF_REGULATIONS_URL).toMatch(/^https:\/\/www\.itftennis\.com\//);
  });
});

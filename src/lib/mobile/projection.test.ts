import { describe, expect, it } from "vitest";
import { buildTimeline, shortCode, toScore, toTeam } from "./projection";
import { scoreLine } from "./contract";
import type { MatchSnapshot, Team } from "../types";

describe("buildTimeline", () => {
  const A = "a";
  it("drops undone points and marks games and sets", () => {
    const rows = [
      { event_number: 1, event_type: "MATCH_STARTED", team_id: null, ga: 0, gb: 0, set: 1 },
      { event_number: 2, event_type: "POINT_AWARDED", team_id: "a", ga: 0, gb: 0, set: 1 },
      { event_number: 3, event_type: "POINT_AWARDED", team_id: "b", ga: 0, gb: 0, set: 1 },
      { event_number: 4, event_type: "UNDO", team_id: null, ga: 0, gb: 0, set: 1 },
      { event_number: 5, event_type: "POINT_AWARDED", team_id: "a", ga: 1, gb: 0, set: 1 },
    ];
    expect(buildTimeline(rows, A)).toEqual([
      { w: "A", set: 1 },
      { w: "A", set: 1, game: "1-0" },
    ]);
  });
  it("labels a set-winning point with the set's final game score", () => {
    const rows = [
      { event_number: 1, event_type: "POINT_AWARDED", team_id: "a", ga: 5, gb: 4, set: 1 },
      { event_number: 2, event_type: "POINT_AWARDED", team_id: "a", ga: 0, gb: 0, set: 2 },
    ];
    expect(buildTimeline(rows, A)[1]).toEqual({ w: "A", set: 1, game: "6-4" });
  });
});

describe("toScore", () => {
  const snap = {
    match_id: "m",
    completed_sets: [{ teamAGames: 6, teamBGames: 4 }],
    team_a_games: 5,
    team_b_games: 4,
    team_a_point_label: "30",
    team_b_point_label: "15",
    is_tiebreak: false,
    tiebreak_team_a_points: 0,
    tiebreak_team_b_points: 0,
    serving_team_id: "a",
    last_event_number: 40,
    last_undo_event_number: 3,
    snapshot_json: { matchOver: false, servingTeam: "A" },
    updated_at: "2026-11-04T10:00:00Z",
  } as unknown as MatchSnapshot;
  it("reads sets, games, points and serve", () => {
    const s = toScore({ team_a_id: "a", team_b_id: "b" }, snap)!;
    expect(s.setsWon).toEqual({ a: 1, b: 0 });
    expect(s.points).toEqual({ a: "30", b: "15" });
    expect(s.serving).toBe("A");
    expect(scoreLine(s)).toBe("6–4 5–4");
  });
  it("shows who serves in a tie-break (the serve rotates: A, B, B, A, A…)", () => {
    const tb = (a: number, b: number) =>
      ({
        ...snap,
        is_tiebreak: true,
        serving_team_id: null,
        tiebreak_team_a_points: a,
        tiebreak_team_b_points: b,
        snapshot_json: { matchOver: false, isTiebreak: true, servingTeam: null, tiebreakFirstServer: "A", teamA: { tiebreakPoints: a }, teamB: { tiebreakPoints: b } },
      }) as unknown as MatchSnapshot;
    const who = (a: number, b: number) => toScore({ team_a_id: "a", team_b_id: "b" }, tb(a, b))!.serving;
    expect([who(0, 0), who(1, 0), who(1, 1), who(2, 1), who(2, 2)]).toEqual(["A", "B", "B", "A", "A"]);
  });
  it("has no games or points once the match is over", () => {
    const s = toScore({ team_a_id: "a", team_b_id: "b" }, { ...snap, snapshot_json: { matchOver: true } } as unknown as MatchSnapshot)!;
    expect(s.games).toBeNull();
    expect(s.points).toBeNull();
  });
});

describe("toTeam", () => {
  it("never carries private columns and hides photos unless allowed", () => {
    const team = {
      id: "t",
      team_name: "Egypt",
      nation_code: "EGY",
      iso2: "eg",
      seed_number: 2,
      team_status: "active",
      phone: "+20100000000",
      notes: "internal",
      check_in_status: "checked_in",
      players: [{ id: "p", full_name: "Judy Tawila", player_order: 1, photo_url: "https://x/y.jpg", portrait_url: null, focal_x: 0.5, focal_y: 0.4 }],
    } as unknown as Team;
    const out = toTeam(team, "g", false);
    expect(JSON.stringify(out)).not.toMatch(/\+20|internal|checked_in/);
    expect(out.players[0]!.photoUrl).toBeNull();
    expect(out.code).toBe("EGY");
  });
  it("adds the ITF ranking and, only when given, the age; never a birth year", () => {
    const team = {
      id: "t",
      team_name: "Egypt",
      nation_code: "EGY",
      iso2: "eg",
      seed_number: 1,
      team_status: "active",
      players: [
        { id: "p1", full_name: "A One", player_order: 1, photo_url: null, portrait_url: null, focal_x: 0.5, focal_y: 0.35, birth_year: 2010 },
        { id: "p2", full_name: "B Two", player_order: 2, photo_url: null, portrait_url: null, focal_x: 0.5, focal_y: 0.35 },
      ],
    } as unknown as Team;
    const plain = toTeam(team, null, false);
    expect(plain.players.map((p) => Object.keys(p).sort())).toEqual([
      ["id", "name", "photoUrl", "teamId"],
      ["id", "name", "photoUrl", "teamId"],
    ]);
    const out = toTeam(team, null, false, { ranks: { p1: 42 }, ages: new Map([["p1", 16]]) });
    expect(out.players[0]).toMatchObject({ itfRank: 42, age: 16 });
    expect(out.players[1]).not.toHaveProperty("itfRank");
    expect(out.players[1]).not.toHaveProperty("age");
    expect(JSON.stringify(out)).not.toMatch(/birth|2010/);
  });
  it("makes a short code from a pair name", () => {
    expect(shortCode("Taymour / Mohsen")).toBe("TM");
  });
});

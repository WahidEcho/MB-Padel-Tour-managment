/**
 * The live courts hero goes to every phone, cached at the CDN: nothing private may
 * be in it. These hold the shapes to account (exact keys, no private values) and
 * the queries behind them (explicit columns, never a private one).
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../supabase", () => ({ db: () => ({}) }));

import { COURT_TEAM_COLUMNS, heroCandidates } from "./courts";
import { CARD_COLUMNS, MATCH_COLUMNS, SNAPSHOT_COLUMNS } from "./server";
import { toCourtCall, toCourtTeam, toSides, toStageRules } from "./projection";
import type { MTournamentCard } from "./contract";
import type { Team } from "../types";

const PRIVATE = ["phone", "email", "access_code", "mobile_normalized", "notes", "check_in_status", "player_profile_id", "player_profiles"];

/** Every key at every depth. */
function allKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) allKeys(x, out);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      allKeys(x, out);
    }
  }
  return out;
}

const row = {
  id: "t1",
  tournament_id: "tour",
  team_name: "Taymour / Mohsen",
  nation_code: null,
  iso2: null,
  phone: "+201000000000",
  notes: "owes entry fee",
  check_in_status: "checked_in",
  players: [
    {
      id: "p2",
      team_id: "t1",
      player_order: 2,
      full_name: "Omar Mohsen",
      photo_url: null,
      portrait_url: null,
      focal_x: 0.5,
      focal_y: 0.35,
      phone: "+201111111111",
      email: "omar@example.com",
      access_code: "ABCD2345",
      player_profile_id: "prof-1",
      player_profiles: { mobile_normalized: "+201222222222" },
    },
    {
      id: "p1",
      team_id: "t1",
      player_order: 1,
      full_name: "Ali Taymour",
      photo_url: "https://x.supabase.co/storage/v1/object/public/photos/a.jpg",
      portrait_url: null,
      focal_x: 0.3,
      focal_y: 0.2,
    },
  ],
} as unknown as Team;

describe("courts hero: nothing private reaches a phone", () => {
  it("a court team carries exactly the public keys", () => {
    const team = toCourtTeam(row, true);
    expect(Object.keys(team).sort()).toEqual(["code", "id", "iso2", "name", "players"]);
    for (const p of team.players) expect(Object.keys(p).sort()).toEqual(["focalX", "focalY", "id", "name", "photoUrl", "teamId"]);
    for (const k of allKeys(team)) expect(PRIVATE).not.toContain(k);
    const json = JSON.stringify(team);
    for (const v of ["+20100", "+20111", "+20122", "omar@example.com", "ABCD2345", "owes entry fee", "checked_in", "prof-1"]) expect(json).not.toContain(v);
  });

  it("keeps players in order with their faces, sized for the hero, and hides them when the event shows none", () => {
    const team = toCourtTeam(row, true);
    expect(team.players.map((p) => p.name)).toEqual(["Ali Taymour", "Omar Mohsen"]);
    expect(team.players[0]!.photoUrl).toContain("/render/image/public/photos/a.jpg?width=800");
    expect(team.players[0]).toMatchObject({ focalX: 0.3, focalY: 0.2 });
    expect(toCourtTeam(row, false).players.every((p) => p.photoUrl === null)).toBe(true);
    expect(team.code).toBe("TM");
  });

  it("a court call says who is here and the deadline, never the phone or the referee", () => {
    const call = toCourtCall({
      match_id: "m",
      court_id: "c",
      called_at: "2026-11-04T12:00:00Z",
      deadline_at: "2026-11-04T12:05:00Z",
      extensions: 1,
      a_present_at: "2026-11-04T12:01:00Z",
      b_present_at: null,
      ...({ device_id: "install-123", called_by_role: "referee", answer: { action: "extend" } } as object),
    } as Parameters<typeof toCourtCall>[0]);
    expect(Object.keys(call).sort()).toEqual(["calledAt", "courtId", "deadlineAt", "extensions", "matchId", "presentA", "presentB"]);
    expect(JSON.stringify(call)).not.toMatch(/install-123|referee|extend/);
    expect(call).toMatchObject({ presentA: true, presentB: false, extensions: 1 });
  });

  it("the queries list their columns, and none is private", () => {
    const src = readFileSync(join(__dirname, "courts.ts"), "utf8");
    // Every select names its columns: no "*" anywhere in this file's queries.
    const selects = [...src.matchAll(/\.select\(([^)]*)\)/g)].map((m) => m[1]!);
    expect(selects.length).toBeGreaterThan(0);
    for (const s of selects) expect(s).not.toMatch(/["'`]\*["'`]/);
    const columnLists = [...src.matchAll(/_COLUMNS\s*=\s*\n?\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(columnLists.length).toBeGreaterThanOrEqual(4);
    for (const list of [...columnLists, COURT_TEAM_COLUMNS, CARD_COLUMNS, MATCH_COLUMNS, SNAPSHOT_COLUMNS]) {
      const names = list.split(/[\s,()]+/).filter(Boolean);
      for (const p of ["phone", "email", "access_code", "mobile_normalized", "notes", "device_id"]) expect(names).not.toContain(p);
      expect(list).not.toContain("*");
    }
  });

  it("names no private field anywhere in the contract shapes it returns", () => {
    const contract = readFileSync(join(__dirname, "contract.ts"), "utf8");
    const hero = contract.slice(contract.indexOf("the live courts hero"), contract.indexOf("personal (never cached)"));
    expect(hero.length).toBeGreaterThan(100);
    for (const p of ["phone", "email", "accessCode", "access_code", "mobile"]) expect(hero).not.toMatch(new RegExp(`\\b${p}\\??:`));
  });
});

describe("courts hero: which tournaments, in which order", () => {
  const card = (id: string): MTournamentCard =>
    ({ id, slug: id, name: id, sport: "padel", status: "active", eventGroupId: null, venue: null, city: null, startsOn: null, endsOn: null, timezone: "Africa/Cairo", liveCount: 1, teamCount: 2, skin: {} }) as MTournamentCard;

  it("featured events first in their order, then the live ones, each once", () => {
    const out = heroCandidates([{ tournaments: [card("f1"), card("f2")] }, { tournaments: [card("f3")] }], [card("l1"), card("f2"), card("l2")]);
    expect(out.map((c) => `${c.card.id}:${c.featured}`)).toEqual(["f1:true", "f2:true", "f3:true", "l1:false", "l2:false"]);
  });
});

describe("bundle: per-stage rules and red/blue sides", () => {
  it("resolves every stage bucket, the Plate inheriting the Cup, doubles for tennis only", () => {
    const r = toStageRules(
      {
        sport: "tennis",
        scoring_config: {
          setsToWinMatch: 2,
          gamesToWinSet: 6,
          tiebreakEnabled: true,
          tiebreakAtGames: 6,
          tiebreakTargetPoints: 7,
          tiebreakWinByTwo: true,
          walkoverScore: "6-0",
          stageOverrides: { quarter_semi: { gamesToWinSet: 4, tiebreakAtGames: 4 }, plate_final: { setsToWinMatch: 1 } },
          doubles: { decidingPoint: true, matchTiebreak: true },
          requireResultConfirmation: true,
        },
      },
      ["b-plate"],
    );
    expect(r.base.setsToWinMatch).toBe(2);
    expect(r.stages.quarter_semi.gamesToWinSet).toBe(4);
    expect(r.stages.plate_quarter_semi.gamesToWinSet).toBe(4);
    expect(r.stages.plate_final.setsToWinMatch).toBe(1);
    expect(r.stages.final.setsToWinMatch).toBe(2);
    expect(r.doubles).toEqual({ decidingPoint: true, matchTiebreak: true });
    expect(r.plateBrackets).toEqual(["b-plate"]);
    expect(JSON.stringify(r)).not.toMatch(/stageOverrides|requireResultConfirmation/);
    expect(toStageRules({ sport: "padel", scoring_config: { ...r.base, doubles: { decidingPoint: true } } }, []).doubles).toBeNull();
  });

  it("carries the red and blue identity, on only when the organiser turned it on", () => {
    expect(toSides({ redBlueTeams: true })).toEqual({ redBlue: true, A: { label: "Red team", short: "RED", hex: "#dc2626" }, B: { label: "Blue team", short: "BLUE", hex: "#2563eb" } });
    expect(toSides(null).redBlue).toBe(false);
  });
});

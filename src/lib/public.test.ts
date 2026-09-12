import { describe, it, expect } from "vitest";
import { PUBLIC_TEAM_KEYS, toPublicTeam, toPublicTournament, type PublicTeam } from "./public";
import type { Team, Tournament } from "./types";

const team: Team = {
  id: "t1",
  tournament_id: "tour",
  team_name: "Falcons",
  phone: "+201000000000",
  notes: "owes entry fee",
  seed_number: 3,
  check_in_status: "checked_in",
  team_status: "active",
  players: [
    {
      id: "p2",
      tournament_id: "tour",
      team_id: "t1",
      player_order: 2,
      full_name: "Second",
      photo_url: null,
      portrait_url: null,
      focal_x: 0.5,
      focal_y: 0.35,
    },
    {
      id: "p1",
      tournament_id: "tour",
      team_id: "t1",
      player_order: 1,
      full_name: "First",
      photo_url: "https://x/a.png",
      portrait_url: null,
      focal_x: 0.3,
      focal_y: 0.2,
      player_profile_id: "prof",
    },
  ],
};

describe("toPublicTeam", () => {
  it("carries exactly the public keys, and never the phone or notes", () => {
    const pub = toPublicTeam(team);
    expect(Object.keys(pub).sort()).toEqual([...PUBLIC_TEAM_KEYS]);
    const serialised = JSON.stringify(pub);
    expect(serialised).not.toContain("+201000000000");
    expect(serialised).not.toContain("owes entry fee");
    expect(serialised).not.toContain("checked_in");
  });

  it("keeps players in their order, with faces and framing", () => {
    const pub = toPublicTeam(team);
    expect(pub.players.map((p) => p.full_name)).toEqual(["First", "Second"]);
    expect(pub.players[0]).toEqual({
      id: "p1",
      full_name: "First",
      photo_url: "https://x/a.png",
      portrait_url: null,
      focal_x: 0.3,
      focal_y: 0.2,
    });
  });

  it("drops the link to a player's persistent profile", () => {
    expect(JSON.stringify(toPublicTeam(team))).not.toContain("prof");
  });

  it("refuses a raw row at compile time", () => {
    // @ts-expect-error — a full Team is not a PublicTeam: phone is `never` here.
    const leak: PublicTeam = team;
    expect(leak).toBeDefined();
  });
});

describe("toPublicTournament", () => {
  it("leaves out the configuration a public page has no use for", () => {
    const t = {
      id: "x",
      name: "Kattamia Heights",
      slug: "kh",
      sport: "padel",
      kind: "tournament",
      status: "active",
      is_demo: false,
      cloned_from_tournament_id: null,
      branding_config: {},
      scoring_config: { setsToWinMatch: 1 },
      format_config: { type: "group_knockout" },
      court_config: { secret: true },
      lower_third_text: "",
      public_access_enabled: true,
      created_at: "",
      updated_at: "",
    } as unknown as Tournament;
    const pub = toPublicTournament(t);
    expect(pub).not.toHaveProperty("scoring_config");
    expect(pub).not.toHaveProperty("court_config");
    expect(pub).not.toHaveProperty("format_config");
    expect(pub.name).toBe("Kattamia Heights");
  });
});

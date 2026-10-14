import { describe, expect, it } from "vitest";
import {
  canSeeLeague,
  codeStillHeld,
  isPublicVisibility,
  LEAGUE_VISIBILITIES,
  LEAGUE_VISIBILITY_BADGE,
  LEAGUE_VISIBILITY_OPTIONS,
  leagueVisibility,
  NOBODY,
  type LeagueViewer,
} from "./visibility";

const as = (patch: Partial<LeagueViewer>): LeagueViewer => ({ ...NOBODY, ...patch });

const VIEWERS: Record<string, LeagueViewer> = {
  signedOutOrOutsider: NOBODY,
  orgPlayer: as({ orgPlayer: true }),
  member: as({ member: true }),
  codeHolder: as({ codeHolder: true }),
  staff: as({ staff: true }),
};

/** The owner's matrix: who sees a league of each visibility. */
const EXPECTED: Record<string, Record<string, boolean>> = {
  everyone: { signedOutOrOutsider: true, orgPlayer: true, member: true, codeHolder: true, staff: true },
  org_players: { signedOutOrOutsider: false, orgPlayer: true, member: true, codeHolder: false, staff: true },
  invite_only: { signedOutOrOutsider: false, orgPlayer: false, member: true, codeHolder: true, staff: true },
};

describe("canSeeLeague", () => {
  for (const v of LEAGUE_VISIBILITIES) {
    for (const [who, viewer] of Object.entries(VIEWERS)) {
      it(`${v} · ${who} → ${EXPECTED[v][who] ? "sees it" : "404"}`, () => {
        expect(canSeeLeague(v, viewer)).toBe(EXPECTED[v][who]);
      });
    }
  }

  it("an org player who also holds the code sees an invite-only league (the code is what counts)", () => {
    expect(canSeeLeague("invite_only", as({ orgPlayer: true, codeHolder: true }))).toBe(true);
  });

  it("a missing value is the column default (everyone); junk fails closed (invite only)", () => {
    expect(leagueVisibility(undefined)).toBe("everyone");
    expect(leagueVisibility(null)).toBe("everyone");
    expect(leagueVisibility("secret")).toBe("invite_only");
    expect(leagueVisibility(3)).toBe("invite_only");
    expect(canSeeLeague("secret", as({ orgPlayer: true }))).toBe(false);
    expect(canSeeLeague("secret", as({ member: true }))).toBe(true);
  });

  it("only 'everyone' is public", () => {
    expect(isPublicVisibility("everyone")).toBe(true);
    expect(isPublicVisibility(undefined)).toBe(true);
    expect(isPublicVisibility("org_players")).toBe(false);
    expect(isPublicVisibility("invite_only")).toBe(false);
    expect(isPublicVisibility("junk")).toBe(false);
  });
});

describe("labels", () => {
  it("the app's badge for the two restricted options, none for everyone", () => {
    expect(LEAGUE_VISIBILITY_BADGE).toEqual({ everyone: null, org_players: "Members only", invite_only: "Invite only" });
  });
  it("the admin selector explains every option", () => {
    expect(LEAGUE_VISIBILITY_OPTIONS.map((o) => o.value)).toEqual([...LEAGUE_VISIBILITIES]);
    for (const o of LEAGUE_VISIBILITY_OPTIONS) expect(o.help.length).toBeGreaterThan(20);
  });
});

describe("codeStillHeld", () => {
  it("holds while the code entered is the current one", () => {
    expect(codeStillHeld("2026-10-14T10:00:00+00:00", "2026-10-14T10:00:00.000Z")).toBe(true);
  });
  it("a new code ends it; a cleared code ends it; nothing held is nothing", () => {
    expect(codeStillHeld("2026-10-14T10:00:00Z", "2026-10-14T11:00:00Z")).toBe(false);
    expect(codeStillHeld("2026-10-14T10:00:00Z", null)).toBe(false);
    expect(codeStillHeld(null, "2026-10-14T10:00:00Z")).toBe(false);
    expect(codeStillHeld("junk", "junk")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  DEFAULT_MATCH_DAY_RULES,
  OFF_MATCH_DAY_RULES,
  matchDayRules,
  newTournamentMatchDayRules,
  publicMatchDay,
  resolveScoringMode,
} from "./rules";

describe("matchDayRules", () => {
  it("reads an unsaved row as all off", () => {
    for (const raw of [{}, null, undefined, "x", 3, [], { configured: false, alerts: { on: true } }, { configured: "true" }]) {
      expect(matchDayRules(raw, "padel")).toEqual(OFF_MATCH_DAY_RULES);
    }
    const off = OFF_MATCH_DAY_RULES;
    expect(off.showcase.on || off.alerts.on || off.matchSoon.on || off.courtCall.on || off.noShow.on || off.widgets.on).toBe(false);
    expect(off.lockScreen.liveActivities).toBe(false);
    expect(off.scoring.mode).toBe("point_by_point");
  });

  it("an unsaved tennis row has the scoring features on, the rest of match day off", () => {
    for (const raw of [{}, null, { configured: false }]) {
      const r = matchDayRules(raw, "tennis");
      expect(r.configured).toBe(false);
      expect(r.alerts.on).toBe(false);
      expect(r.features.doublesOrder && r.features.fault && r.features.callMaster).toBe(true);
    }
    // A switch the admins turned off stays off.
    expect(matchDayRules({ features: { doublesOrder: false } }, "tennis").features).toMatchObject({ doublesOrder: false, fault: true });
    // Padel keeps them off until switched on.
    expect(matchDayRules({}, "padel").features.fault).toBe(false);
  });

  it("keeps a saved row's known keys", () => {
    const r = matchDayRules({ ...DEFAULT_MATCH_DAY_RULES, alerts: { on: false }, scoring: { mode: "final_score" } }, "padel");
    expect(r.configured).toBe(true);
    expect(r.alerts.on).toBe(false);
    expect(r.scoring.mode).toBe("final_score");
    expect(r.courtCall).toEqual(DEFAULT_MATCH_DAY_RULES.courtCall);
  });

  it("fills missing groups from the defaults", () => {
    expect(matchDayRules({ configured: true }, "tennis")).toEqual(DEFAULT_MATCH_DAY_RULES);
  });

  it("drops unknown keys and wrong types", () => {
    const r = matchDayRules(
      { configured: true, secret: "x", alerts: { on: "yes", extra: 1 }, courtCall: { minutes: "10" }, scoring: { mode: "magic" } },
      "padel",
    ) as unknown as Record<string, unknown>;
    expect(r.secret).toBeUndefined();
    expect((r.alerts as Record<string, unknown>).extra).toBeUndefined();
    expect((r.alerts as { on: boolean }).on).toBe(true);
    expect((r.courtCall as { minutes: number }).minutes).toBe(5);
    expect((r.scoring as { mode: string }).mode).toBe("either");
  });

  it("clamps minutes to 1–30 and extensions to 0–5", () => {
    const r = matchDayRules(
      {
        configured: true,
        courtCall: { minutes: 0, reminderMinutes: 99 },
        noShow: { extensionMinutes: -4, maxExtensions: 12 },
        extras: { warmUpMinutes: 7.6 },
      },
      "padel",
    );
    expect(r.courtCall.minutes).toBe(1);
    expect(r.courtCall.reminderMinutes).toBe(30);
    expect(r.noShow.extensionMinutes).toBe(1);
    expect(r.noShow.maxExtensions).toBe(5);
    expect(r.extras.warmUpMinutes).toBe(8);
    expect(matchDayRules({ configured: true, noShow: { maxExtensions: -1 } }, "padel").noShow.maxExtensions).toBe(0);
    expect(matchDayRules({ configured: true, courtCall: { minutes: Number.NaN } }, "padel").courtCall.minutes).toBe(5);
  });

  it("switches off what the sport cannot do", () => {
    const chess = matchDayRules(DEFAULT_MATCH_DAY_RULES, "chess");
    expect(chess.showcase.on).toBe(false);
    expect(chess.matchSoon.on).toBe(false);
    expect(chess.lockScreen.liveActivities).toBe(false);
    expect(chess.widgets.on).toBe(false);
    expect(chess.courtCall.on).toBe(true);
    const squash = matchDayRules({ ...DEFAULT_MATCH_DAY_RULES, extras: { ...DEFAULT_MATCH_DAY_RULES.extras, umpireVoiceCall: true } }, "squash");
    expect(squash.extras.umpireVoiceCall).toBe(false);
    expect(matchDayRules({ ...DEFAULT_MATCH_DAY_RULES, extras: { ...DEFAULT_MATCH_DAY_RULES.extras, umpireVoiceCall: true } }, { sport: "tennis" }).extras.umpireVoiceCall).toBe(true);
  });

  it("starts new tournaments with the defaults on", () => {
    const r = newTournamentMatchDayRules("padel");
    expect(r.configured).toBe(true);
    expect(r.showcase.on && r.alerts.on && r.courtCall.on && r.noShow.on).toBe(true);
    expect(r.matchSoon.starredFans).toBe(false);
    expect(r.lockScreen.autoStartStarred).toBe(false);
  });

  it("round-trips what it produces", () => {
    const r = newTournamentMatchDayRules("tennis");
    expect(matchDayRules(JSON.parse(JSON.stringify(r)), "tennis")).toEqual(r);
  });
});

describe("publicMatchDay", () => {
  it("carries only what a phone acts on", () => {
    const p = publicMatchDay(DEFAULT_MATCH_DAY_RULES);
    expect(Object.keys(p).sort()).toEqual(
      [
        "alerts",
        "autoStartFollowed",
        "autoStartMine",
        "autoStartStarred",
        "callMinutes",
        "countdown",
        "courtCall",
        "eventDaysOnly",
        "imAtCourt",
        "liveActivities",
        "matchSoon",
        "on",
        "qrCheckIn",
        "showcase",
        "warmUpMinutes",
        "widgets",
      ].sort(),
    );
    expect(p.on).toBe(true);
    expect(p.callMinutes).toBe(5);
    expect(p.warmUpMinutes).toBeNull();
    expect(publicMatchDay(OFF_MATCH_DAY_RULES).on).toBe(false);
  });
});

describe("resolveScoringMode", () => {
  const rules = DEFAULT_MATCH_DAY_RULES;
  it("prefers the match, then the session, then the tournament", () => {
    expect(resolveScoringMode({ matchOverride: "final_score", sessionMode: "point_by_point", rules })).toBe("final_score");
    expect(resolveScoringMode({ matchOverride: null, sessionMode: "point_by_point", rules })).toBe("point_by_point");
    expect(resolveScoringMode({ matchOverride: "either", sessionMode: "either", rules })).toBe("either");
    expect(resolveScoringMode({ rules: OFF_MATCH_DAY_RULES })).toBe("point_by_point");
    expect(resolveScoringMode({ matchOverride: "bogus", rules: { ...rules, scoring: { mode: "final_score" } } })).toBe("final_score");
  });
});

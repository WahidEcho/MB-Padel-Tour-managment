import { describe, expect, it } from "vitest";
import {
  breakRemainingSeconds,
  formatCountdown,
  modeChangeEffects,
  parseScreenCommand,
  resolveScreenCommand,
  type CommandContext,
} from "./commands";
import {
  CEREMONY,
  ceremonySteps,
  describeStep,
  revealedPlaces,
  podiumCount,
  sessionCeremonyTier,
  shortTiers,
  stepAt,
  type CeremonyPerson,
  type CeremonyTier,
} from "./ceremony";
import { defaultScreenSettings } from "../data";
import type { ScreenSettings } from "../types";

const NOW = Date.parse("2026-09-13T18:00:00.000Z");
const screen = { ...defaultScreenSettings("t1", "main"), ceremony_step: 0 };
const ctx = (over: Partial<CommandContext> = {}): CommandContext => ({
  nowMs: NOW,
  ceremonyLastStep: 5,
  liveMatchCourt: (id) => (id === "m-live" ? "court-1" : undefined),
  ...over,
});
const form = (values: Record<string, string>) => (name: string) => values[name] ?? null;

describe("parseScreenCommand", () => {
  it("reads every control the console offers", () => {
    expect(parseScreenCommand(form({ command: "mute_on" }))).toEqual({ kind: "mute", on: true });
    expect(parseScreenCommand(form({ command: "break_start", break_minutes: "10" }))).toEqual({ kind: "break_start", minutes: 10 });
    expect(parseScreenCommand(form({ command: "ceremony_next" }))).toEqual({ kind: "ceremony", move: "next" });
    expect(parseScreenCommand(form({ command: "replay_entrance", match_id: "m1" }))).toEqual({ kind: "replay_entrance", matchId: "m1" });
  });

  it("rejects nonsense rather than guessing", () => {
    expect(parseScreenCommand(form({ command: "self_destruct" }))).toBeNull();
    expect(parseScreenCommand(form({ command: "break_start", break_minutes: "-5" }))).toBeNull();
    expect(parseScreenCommand(form({ command: "replay_entrance" }))).toBeNull();
  });

  it("caps a break at two hours", () => {
    expect(parseScreenCommand(form({ command: "break_start", break_minutes: "9999" }))).toEqual({ kind: "break_start", minutes: 120 });
  });
});

describe("resolveScreenCommand", () => {
  it("stamps a break's end from the server clock, so a reload rejoins the same countdown", () => {
    const r = resolveScreenCommand({ kind: "break_start", minutes: 10 }, screen, ctx());
    expect(r).toEqual({
      ok: true,
      patch: { break_started_at: "2026-09-13T18:00:00.000Z", break_ends_at: "2026-09-13T18:10:00.000Z" },
    });
  });

  it("ends a break by clearing both stamps", () => {
    expect(resolveScreenCommand({ kind: "break_end" }, screen, ctx())).toEqual({
      ok: true,
      patch: { break_started_at: null, break_ends_at: null },
    });
  });

  it("replays an entrance only for a live match on a court the screen covers", () => {
    const live = { ...screen, display_mode: "live" as const };
    expect(resolveScreenCommand({ kind: "replay_entrance", matchId: "m-live" }, live, ctx({ liveMatchEvent: () => 14 }))).toEqual({
      ok: true,
      patch: { entrance_replay: { match_id: "m-live", at: "2026-09-13T18:00:00.000Z", event_number: 14 } },
    });
    expect(resolveScreenCommand({ kind: "replay_entrance", matchId: "m-over" }, live, ctx()).ok).toBe(false);
    const elsewhere = { ...live, court_ids: ["court-5"] };
    expect(resolveScreenCommand({ kind: "replay_entrance", matchId: "m-live" }, elsewhere, ctx())).toEqual({
      ok: false,
      reason: "that court is not on it",
    });
  });

  it("refuses a replay wherever the wall could not actually play it", () => {
    const live: ScreenSettings = { ...screen, display_mode: "live" };
    const reason = (s: ScreenSettings, over: Partial<CommandContext> = {}) => {
      const r = resolveScreenCommand({ kind: "replay_entrance", matchId: "m-live" }, s, ctx(over));
      return r.ok ? null : r.reason;
    };
    expect(reason({ ...live, display_mode: "leaderboard" })).toBe("it is not showing live courts");
    expect(reason({ ...live, focus_court_id: "court-3" })).toBe("it is pinned to another court");
    expect(reason({ ...live, mute_animations: true })).toBe("its animations are muted");
    expect(reason(live, { isChess: true })).toBe("chess boards have no player entrance");
    expect(reason(live, { coveredCourtCount: 6 })).toBe("its court cards are too small for an entrance");
    expect(reason(live, { coveredCourtCount: 4 })).toBeNull();
    expect(reason({ ...live, focus_court_id: "court-1" }, { coveredCourtCount: 6 })).toBeNull();
    expect(reason(live, { liveMatchCourt: () => null })).toBe("that match has no court, so no card shows it");
  });

  it("walks the ceremony forward and back within its steps, re-stamping every move", () => {
    const at = (step: number) => ({ ...screen, display_mode: "ceremony" as const, ceremony_step: step });
    expect(resolveScreenCommand({ kind: "ceremony", move: "next" }, at(2), ctx())).toEqual({
      ok: true,
      patch: { ceremony_step: 3, ceremony_step_at: "2026-09-13T18:00:00.000Z" },
    });
    expect(resolveScreenCommand({ kind: "ceremony", move: "next" }, at(5), ctx())).toMatchObject({ patch: { ceremony_step: 5 } });
    expect(resolveScreenCommand({ kind: "ceremony", move: "back" }, at(0), ctx())).toMatchObject({ patch: { ceremony_step: 0 } });
    expect(resolveScreenCommand({ kind: "ceremony", move: "replay" }, at(3), ctx())).toMatchObject({ patch: { ceremony_step: 3 } });
    expect(resolveScreenCommand({ kind: "ceremony", move: "restart" }, at(4), ctx())).toMatchObject({ patch: { ceremony_step: 0 } });
  });

  it("does not move a ceremony that is not on air", () => {
    expect(resolveScreenCommand({ kind: "ceremony", move: "next" }, { ...screen, display_mode: "live" }, ctx())).toEqual({
      ok: false,
      reason: "it is not showing the ceremony",
    });
  });

  it("refuses a pushed move from a view that was a step behind, instead of skipping a reveal", () => {
    const onAir = { ...screen, display_mode: "ceremony" as const, ceremony_step: 3 };
    expect(resolveScreenCommand({ kind: "ceremony", move: "next" }, onAir, ctx({ expectedCeremonyStep: 2 }))).toEqual({
      ok: false,
      reason: "someone moved its ceremony a moment ago",
      conflict: true,
    });
    expect(resolveScreenCommand({ kind: "ceremony", move: "next" }, onAir, ctx({ expectedCeremonyStep: 3 }))).toMatchObject({
      patch: { ceremony_step: 4 },
    });
  });

  it("pulls a stale step back inside a ceremony that has since become shorter", () => {
    const stale = { ...screen, display_mode: "ceremony" as const, ceremony_step: 9 };
    expect(resolveScreenCommand({ kind: "ceremony", move: "back" }, stale, ctx({ ceremonyLastStep: 3 }))).toMatchObject({
      patch: { ceremony_step: 2 },
    });
  });
});

describe("modeChangeEffects", () => {
  it("starts the ceremony from its slate when it goes on air", () => {
    expect(modeChangeEffects({ display_mode: "ceremony" }, { display_mode: "live", bracket_tier: "cup" }, NOW)).toEqual({
      display_mode: "ceremony",
      ceremony_step: 0,
      ceremony_step_at: "2026-09-13T18:00:00.000Z",
    });
  });

  it("leaves a running ceremony where it is when the mode is pressed again", () => {
    expect(modeChangeEffects({ display_mode: "ceremony" }, { display_mode: "ceremony", bracket_tier: "cup" }, NOW)).toEqual({
      display_mode: "ceremony",
    });
  });

  it("airs Plate then Cup by default when a Plate bracket is published, unless a tier was chosen", () => {
    expect(
      modeChangeEffects({ display_mode: "ceremony" }, { display_mode: "live", bracket_tier: "cup" }, NOW, { plateBracketPublished: true }),
    ).toMatchObject({ bracket_tier: "both", ceremony_step: 0 });
    expect(
      modeChangeEffects({ display_mode: "ceremony", bracket_tier: "cup" }, { display_mode: "live", bracket_tier: "both" }, NOW, {
        plateBracketPublished: true,
      }),
    ).toMatchObject({ bracket_tier: "cup", ceremony_step: 0 });
    expect(
      modeChangeEffects({ display_mode: "ceremony" }, { display_mode: "live", bracket_tier: "cup" }, NOW, { plateBracketPublished: false }),
    ).not.toHaveProperty("bracket_tier");
  });

  it("shows both trees when the bracket scene goes on air with a Plate published", () => {
    expect(
      modeChangeEffects({ display_mode: "bracket" }, { display_mode: "live", bracket_tier: "cup" }, NOW, {
        plateBracketPublished: true,
      }),
    ).toMatchObject({ bracket_tier: "both" });
  });

  it("keeps a tier the operator chose with the bracket scene", () => {
    expect(
      modeChangeEffects({ display_mode: "bracket", bracket_tier: "cup" }, { display_mode: "live", bracket_tier: "both" }, NOW, {
        plateBracketPublished: true,
      }),
    ).toMatchObject({ bracket_tier: "cup" });
  });

  it("leaves the bracket scene alone when there is no Plate", () => {
    expect(
      modeChangeEffects({ display_mode: "bracket" }, { display_mode: "live", bracket_tier: "cup" }, NOW, {
        plateBracketPublished: false,
      }),
    ).not.toHaveProperty("bracket_tier");
  });

  it("restarts from the slate when the podiums shown change on air, so no champion appears unrevealed", () => {
    expect(modeChangeEffects({ bracket_tier: "cup" }, { display_mode: "ceremony", bracket_tier: "both" }, NOW)).toEqual({
      bracket_tier: "cup",
      ceremony_step: 0,
      ceremony_step_at: "2026-09-13T18:00:00.000Z",
    });
    expect(modeChangeEffects({ bracket_tier: "both" }, { display_mode: "ceremony", bracket_tier: "both" }, NOW)).toEqual({
      bracket_tier: "both",
    });
    expect(modeChangeEffects({ bracket_tier: "cup" }, { display_mode: "bracket", bracket_tier: "both" }, NOW)).toEqual({
      bracket_tier: "cup",
    });
  });
});

describe("break countdown", () => {
  it("counts whole seconds down to zero and never below", () => {
    expect(breakRemainingSeconds("2026-09-13T18:10:00.000Z", NOW)).toBe(600);
    expect(breakRemainingSeconds("2026-09-13T18:00:00.400Z", NOW)).toBe(1);
    expect(breakRemainingSeconds("2026-09-13T17:59:00.000Z", NOW)).toBe(0);
    expect(breakRemainingSeconds(null, NOW)).toBeNull();
  });

  it("formats like a clock", () => {
    expect(formatCountdown(245)).toBe("4:05");
    expect(formatCountdown(720)).toBe("12:00");
    expect(formatCountdown(0)).toBe("0:00");
  });
});

const person = (id: string): CeremonyPerson => ({ id, name: `P ${id}`, photo_url: null, portrait_url: null, focal_x: 0.5, focal_y: 0.35 });
const team = (title: string) => ({ title, people: [person(`${title}-1`), person(`${title}-2`)] });

describe("ceremony sequence", () => {
  const plate: CeremonyTier = {
    key: "plate",
    label: "Plate",
    places: [
      { place: 1, entrants: [team("Hawks")] },
      { place: 2, entrants: [team("Owls")] },
    ],
    configuredDepth: 2,
  };
  const cup: CeremonyTier = {
    key: "cup",
    label: "Cup",
    places: [1, 2, 3, 4].map((place) => ({ place, entrants: [team(`Cup${place}`)] })),
    configuredDepth: 4,
  };

  it("runs the Plate first, then the Cup, each from its slate and deepest place up", () => {
    expect(ceremonySteps([plate, cup])).toEqual([
      { kind: "slate", tierIndex: 0 },
      { kind: "place", tierIndex: 0, place: 2 },
      { kind: "place", tierIndex: 0, place: 1 },
      { kind: "slate", tierIndex: 1 },
      { kind: "place", tierIndex: 1, place: 4 },
      { kind: "place", tierIndex: 1, place: 3 },
      { kind: "place", tierIndex: 1, place: 2 },
      { kind: "place", tierIndex: 1, place: 1 },
    ]);
  });

  it("skips a tier with nothing decided", () => {
    expect(ceremonySteps([{ ...plate, places: [] }, cup])[0]).toEqual({ kind: "slate", tierIndex: 1 });
  });

  it("keeps every place revealed so far on stage, champion first", () => {
    const steps = ceremonySteps([plate, cup]);
    expect(revealedPlaces([plate, cup], steps[5]).map((p) => p.place)).toEqual([3, 4]);
    expect(revealedPlaces([plate, cup], steps[7]).map((p) => p.place)).toEqual([1, 2, 3, 4]);
    expect(revealedPlaces([plate, cup], steps[3])).toEqual([]);
  });

  it("clamps a stored step, and describes it for the operator", () => {
    const steps = ceremonySteps([plate, cup]);
    expect(stepAt(steps, 99).index).toBe(7);
    expect(stepAt([], 3)).toEqual({ step: null, index: 0 });
    expect(describeStep([plate, cup], steps, 1)).toBe("Plate — 2nd place (2 of 8)");
    expect(describeStep([plate, cup], steps, 7)).toBe("Cup — Champion (8 of 8)");
    expect(describeStep([], [], 0)).toContain("Nothing to reveal");
  });

  it("does not call a tied podium short: ranks 1, 2, 2 fill three places", () => {
    const players = new Map(["a", "b", "c"].map((id) => [id, person(id)]));
    const tier = sessionCeremonyTier(
      "Session",
      [
        { player_profile_id: "a", rank: 1, points: 9 },
        { player_profile_id: "b", rank: 2, points: 6 },
        { player_profile_id: "c", rank: 2, points: 6 },
      ],
      players,
      3,
    );
    expect(shortTiers([tier])).toEqual([]);
    expect(podiumCount(tier)).toBe(3);
  });

  it("tells the operator when a tier has fewer decided places than configured", () => {
    expect(shortTiers([{ ...cup, places: cup.places.slice(0, 2) }])).toEqual(["Cup is set to 4 places but only 2 are decided"]);
  });

  it("builds a session podium from the ranking, with ties sharing a place", () => {
    const players = new Map(["a", "b", "c", "d", "e"].map((id) => [id, person(id)]));
    const tier = sessionCeremonyTier(
      "Friday Americano",
      [
        { player_profile_id: "a", rank: 1, points: 12 },
        { player_profile_id: "b", rank: 2, points: 9 },
        { player_profile_id: "c", rank: 2, points: 9 },
        { player_profile_id: "d", rank: 4, points: 6 },
        { player_profile_id: "e", rank: 5, points: 3 },
      ],
      players,
      3,
    );
    expect(tier.places.map((p) => [p.place, p.entrants.map((e) => e.title)])).toEqual([
      [1, ["P a"]],
      [2, ["P b", "P c"]],
    ]);
    expect(ceremonySteps([tier]).map((s) => (s.kind === "place" ? s.place : "slate"))).toEqual(["slate", 2, 1]);
  });
});

describe("ceremony timing", () => {
  it("lets a wall that learns of a step a poll late still play the champion's celebration", () => {
    const pollLateMs = 2_000 + 500;
    expect(CEREMONY.skipAfterMs).toBeGreaterThan(CEREMONY.floodMs + pollLateMs);
  });
});

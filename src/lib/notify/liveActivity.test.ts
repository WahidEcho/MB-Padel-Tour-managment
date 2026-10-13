import { describe, expect, it } from "vitest";
import type { MScore } from "../mobile/contract";
import {
  normalizeApnsToken,
  APNS_TOKEN,
  COUNTDOWN_GRACE_SECONDS,
  FINAL_DISMISS_SECONDS,
  LIVE_ACTIVITY_ATTRIBUTES_TYPE,
  LIVE_ACTIVITY_NAME,
  LIVE_STALE_SECONDS,
  apnsVerdict,
  liveState,
  matchIdFromUrl,
  matchUrl,
  parseStartTokenBody,
  phaseForMatch,
  startAlert,
  startByPushAllowed,
  startPayload,
  staleDateFor,
  upcomingState,
  updatePayload,
} from "./liveActivity";

const MATCH = "5b0c6f0e-6a55-4d2a-9a0b-0d7f3c1e2a11";
const NOW = 1_800_000_000; // epoch seconds
const TOKEN = "a1".repeat(40);

const score: MScore = {
  sets: [{ a: 6, b: 4 }],
  games: { a: 2, b: 1 },
  points: { a: "30", b: "15" },
  tiebreak: false,
  serving: "B",
  setsWon: { a: 1, b: 0 },
  lastEventNumber: 40,
  lastUndo: 0,
  updatedAt: null,
};

describe("liveState", () => {
  it("keeps the fields older apps read and adds phase and match", () => {
    const s = liveState(score, { a: "EGY", b: "TUN", court: "Centre", status: "Live" }, { matchId: MATCH });
    expect(s).toMatchObject({ a: "EGY", b: "TUN", sets: "6-4 2-1", points: "30-15", serving: "B", status: "Live", court: "Centre", matchId: MATCH, phase: "live", until: null });
  });

  it("reads Final as the final phase and drops the serve dot", () => {
    const s = liveState(score, { a: "EGY", b: "TUN", court: "", status: "Final" });
    expect(s.phase).toBe("final");
    expect(s.serving).toBeNull();
    expect(s.matchId).toBeUndefined();
  });

  it("works without a score", () => {
    expect(liveState(null, { a: "A", b: "B", court: "", status: "Live" })).toMatchObject({ sets: "", points: "", serving: null });
  });
});

describe("upcomingState", () => {
  it("carries the countdown for a call", () => {
    const s = upcomingState({ matchId: MATCH, phase: "called", a: "EGY", b: "TUN", court: "Court 2", until: 1_000_000, from: 700_000 });
    expect(s).toMatchObject({ phase: "called", status: "Called to court", until: 1_000_000, from: 700_000, points: "", sets: "" });
  });

  it("shows no timer when the countdown is off or unknown", () => {
    expect(upcomingState({ matchId: MATCH, phase: "soon", a: "A", b: "B", court: "", until: 5, countdown: false })).toMatchObject({ until: null, from: null, status: "Up next" });
    expect(upcomingState({ matchId: MATCH, phase: "soon", a: "A", b: "B", court: "", until: null })).toMatchObject({ until: null });
  });
});

describe("phaseForMatch", () => {
  it("maps status and call to a phase", () => {
    expect(phaseForMatch({ status: "completed" })?.phase).toBe("final");
    expect(phaseForMatch({ status: "walkover" })?.phase).toBe("final");
    expect(phaseForMatch({ status: "paused" })?.phase).toBe("live");
    expect(phaseForMatch({ status: "cancelled" })).toBeNull();
    expect(phaseForMatch({ status: "scheduled" })).toBeNull();
    expect(phaseForMatch({ status: "ready", call: { phase: "reminder", deadlineAt: 900, calledAt: 600 } })).toEqual({ phase: "called", until: 900, from: 600 });
    // A closed call no longer counts down.
    expect(phaseForMatch({ status: "ready", call: { phase: "closed", deadlineAt: 900, calledAt: 600 } })).toBeNull();
    expect(phaseForMatch({ status: "scheduled", nextOnCourt: true, scheduledTime: "2027-01-01T10:00:00Z" })).toEqual({ phase: "soon", until: Date.parse("2027-01-01T10:00:00Z"), from: null });
    expect(phaseForMatch({ status: "scheduled", nextOnCourt: true })).toEqual({ phase: "soon", until: null, from: null });
  });
});

describe("stale dates", () => {
  it("live cards go stale two minutes after the last push", () => {
    expect(staleDateFor(liveState(score, { a: "A", b: "B", court: "", status: "Live" }), NOW)).toBe(NOW + LIVE_STALE_SECONDS);
  });

  it("countdown cards stay fresh until a while after the deadline", () => {
    const until = (NOW + 300) * 1000;
    const s = upcomingState({ matchId: MATCH, phase: "called", a: "A", b: "B", court: "", until });
    expect(staleDateFor(s, NOW)).toBe(NOW + 300 + COUNTDOWN_GRACE_SECONDS);
  });

  it("final cards have none", () => {
    expect(staleDateFor(liveState(score, { a: "A", b: "B", court: "", status: "Final" }), NOW)).toBeUndefined();
  });
});

describe("updatePayload", () => {
  it("wraps the props as expo-widgets' content state", () => {
    const state = liveState(score, { a: "EGY", b: "TUN", court: "", status: "Live" }, { matchId: MATCH });
    const p = updatePayload(state, { nowSec: NOW });
    expect(p.aps.event).toBe("update");
    expect(p.aps.timestamp).toBe(NOW);
    expect(p.aps["content-state"].name).toBe(LIVE_ACTIVITY_NAME);
    expect(JSON.parse(p.aps["content-state"].props)).toEqual(state);
    expect(p.aps["stale-date"]).toBe(NOW + LIVE_STALE_SECONDS);
    expect("dismissal-date" in p.aps).toBe(false);
    expect("alert" in p.aps).toBe(false);
  });

  it("ends with a dismissal date and no stale date", () => {
    const p = updatePayload(liveState(score, { a: "A", b: "B", court: "", status: "Final" }), { nowSec: NOW, end: true });
    expect(p.aps.event).toBe("end");
    expect(p.aps["dismissal-date"]).toBe(NOW + FINAL_DISMISS_SECONDS);
    expect("stale-date" in p.aps).toBe(false);
  });

  it("can carry an alert", () => {
    const p = updatePayload(upcomingState({ matchId: MATCH, phase: "called", a: "A", b: "B", court: "", until: null }), { nowSec: NOW, alert: { title: "t", body: "b" } });
    expect(p.aps).toMatchObject({ alert: { title: "t", body: "b" }, sound: "default" });
  });
});

describe("startPayload", () => {
  it("is a push-to-start for expo-widgets' attributes, with the match link and an alert", () => {
    const until = (NOW + 300) * 1000;
    const state = upcomingState({ matchId: MATCH, phase: "called", a: "EGY", b: "TUN", court: "Court 2", until, from: NOW * 1000 });
    const p = startPayload(state, { nowSec: NOW, alert: startAlert(state) });
    expect(p.aps.event).toBe("start");
    expect(p.aps["attributes-type"]).toBe(LIVE_ACTIVITY_ATTRIBUTES_TYPE);
    expect(p.aps.attributes).toEqual({ url: `movescore://match/${MATCH}` });
    expect(JSON.parse(p.aps["content-state"].props)).toMatchObject({ phase: "called", until, matchId: MATCH });
    expect(p.aps["input-push-token"]).toBe(1);
    expect(p.aps.alert).toEqual({ title: "Called to court", body: "EGY v TUN on Court 2. Head to the court now." });
    expect(p.aps["stale-date"]).toBe(NOW + 300 + COUNTDOWN_GRACE_SECONDS);
  });

  it("needs a match id", () => {
    const state = liveState(score, { a: "A", b: "B", court: "", status: "Live" });
    expect(() => startPayload(state, { nowSec: NOW, alert: startAlert(state) })).toThrow(/matchId/);
  });

  it("alerts per phase", () => {
    const base = { matchId: MATCH, a: "", b: "TUN", court: "", until: null };
    expect(startAlert(upcomingState({ ...base, phase: "soon" }))).toEqual({ title: "Your match is up next", body: "TBD v TUN." });
    expect(startAlert(liveState(score, { a: "EGY", b: "TUN", court: "C1", status: "Live" })).title).toBe("Match live");
  });
});

describe("startByPushAllowed", () => {
  const on = { liveActivities: true, startByPush: true };
  it("follows the tournament's switches and never starts a finished match", () => {
    expect(startByPushAllowed(on, "called")).toBe(true);
    expect(startByPushAllowed(on, "live")).toBe(true);
    expect(startByPushAllowed(on, "final")).toBe(false);
    expect(startByPushAllowed({ ...on, startByPush: false }, "called")).toBe(false);
    expect(startByPushAllowed({ ...on, liveActivities: false }, "soon")).toBe(false);
  });
});

describe("links", () => {
  it("round-trips the match link", () => {
    expect(matchIdFromUrl(matchUrl(MATCH))).toBe(MATCH);
    expect(matchIdFromUrl(`${matchUrl(MATCH)}?x=1`)).toBe(MATCH);
    expect(matchIdFromUrl("movescore://tie/abc")).toBeNull();
    expect(matchIdFromUrl(null)).toBeNull();
    expect(matchIdFromUrl("https://evil.example/match/abc")).toBeNull();
  });
});

describe("parseStartTokenBody", () => {
  it("takes exactly { token } with a hex token", () => {
    expect(parseStartTokenBody({ token: TOKEN.toUpperCase() })).toEqual({ ok: true, token: TOKEN });
  });

  it("refuses everything else", () => {
    expect(parseStartTokenBody(null).ok).toBe(false);
    expect(parseStartTokenBody([TOKEN]).ok).toBe(false);
    expect(parseStartTokenBody("x").ok).toBe(false);
    expect(parseStartTokenBody({}).ok).toBe(false);
    expect(parseStartTokenBody({ token: "zz".repeat(40) }).ok).toBe(false);
    expect(parseStartTokenBody({ token: "ab" }).ok).toBe(false);
    expect(parseStartTokenBody({ token: "ab".repeat(201) }).ok).toBe(false);
    expect(parseStartTokenBody({ token: 123 }).ok).toBe(false);
    const extra = parseStartTokenBody({ token: TOKEN, installationId: "x" });
    expect(extra).toEqual({ ok: false, error: "Unknown field: installationId" });
  });

  it("matches the token pattern used by the update-token route", () => {
    expect(APNS_TOKEN.test(TOKEN)).toBe(true);
    expect(APNS_TOKEN.test(`${TOKEN} `)).toBe(false);
  });
});

describe("apnsVerdict", () => {
  it("sorts Apple's answers", () => {
    expect(apnsVerdict({ status: 200, reason: null })).toBe("ok");
    expect(apnsVerdict({ status: 410, reason: "Unregistered" })).toBe("dead");
    expect(apnsVerdict({ status: 400, reason: "BadDeviceToken" })).toBe("dead");
    expect(apnsVerdict({ status: 403, reason: "InvalidProviderToken" })).toBe("config");
    expect(apnsVerdict({ status: 400, reason: "TopicDisallowed" })).toBe("config");
    expect(apnsVerdict({ status: 429, reason: "TooManyRequests" })).toBe("retry");
    expect(apnsVerdict({ status: 0, reason: "stream error" })).toBe("retry");
  });
});

describe("L7: one form of a push token, registering and ending", () => {
  it("normalises case and spaces, and nothing else", () => {
    const t = "AB".repeat(32);
    expect(normalizeApnsToken(` ${t} `)).toBe("ab".repeat(32));
    expect(normalizeApnsToken(normalizeApnsToken(t))).toBe(normalizeApnsToken(t));
    expect(normalizeApnsToken(42)).toBe("");
    expect(APNS_TOKEN.test(normalizeApnsToken(t))).toBe(true);
  });
});

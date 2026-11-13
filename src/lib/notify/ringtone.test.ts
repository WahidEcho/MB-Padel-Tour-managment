import { describe, expect, it } from "vitest";
import { hasPlayerRingtone, playerCallData, playerCallPush, PLAYER_CALL_KINDS, ringsWithAlarm } from "./ringtone";

describe("player call ringtone", () => {
  it("rings the repeats like the call", () => {
    expect(PLAYER_CALL_KINDS.has("call_ring")).toBe(true);
    expect(PLAYER_CALL_KINDS.has("call_withdrawn")).toBe(false);
  });
  it("uses the players' chime only on builds that carry it", () => {
    expect(hasPlayerRingtone("1.0.5")).toBe(false);
    expect(hasPlayerRingtone("1.0.6")).toBe(true);
    expect(hasPlayerRingtone("1.1.0")).toBe(true);
    expect(hasPlayerRingtone(null)).toBe(false);
    expect(ringsWithAlarm("1.0.3")).toBe(true);
  });
  it("1.0.3–1.0.5 ring the alarm on its channel; later builds the chime on theirs", () => {
    expect(playerCallPush("1.0.5")).toMatchObject({ sound: "master_alarm.wav", channelId: "assistance_alarm", categoryId: "player_call", interruptionLevel: "time-sensitive" });
    expect(playerCallPush("1.0.6")).toMatchObject({ sound: "player_call.wav", channelId: "player_call", categoryId: "player_call" });
  });
  it("gives a call one Android notification per match that counts down to the deadline", () => {
    const url = "movescore://match/49CC1514-332d-48bd-81f3-13ed8c32dc9a";
    const now = Date.parse("2026-11-13T14:00:00Z");
    const deadline = "2026-11-13T14:05:00Z";
    for (const kind of ["called_to_court", "call_ring", "call_reminder"]) {
      expect(playerCallData(kind, url, deadline, now)).toEqual({ notifTag: "call:49cc1514-332d-48bd-81f3-13ed8c32dc9a", countdownUntil: Date.parse(deadline) });
    }
    // The withdrawal replaces it with no countdown; a passed deadline counts nothing.
    expect(playerCallData("call_withdrawn", url, deadline, now)).toEqual({ notifTag: "call:49cc1514-332d-48bd-81f3-13ed8c32dc9a" });
    expect(playerCallData("call_ring", url, "2026-11-13T13:59:00Z", now)).toEqual({ notifTag: "call:49cc1514-332d-48bd-81f3-13ed8c32dc9a" });
    // Other alerts and other links carry nothing.
    expect(playerCallData("match_soon", url, deadline, now)).toEqual({});
    expect(playerCallData("call_ring", "movescore://t/demo", deadline, now)).toEqual({});
  });
});

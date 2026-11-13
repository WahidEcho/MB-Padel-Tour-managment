import { describe, expect, it } from "vitest";
import { hasPlayerRingtone, playerCallPush, PLAYER_CALL_KINDS, ringsWithAlarm } from "./ringtone";

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
});

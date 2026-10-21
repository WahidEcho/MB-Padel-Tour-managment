import { describe, it, expect } from "vitest";
import { NUDGE_DAYS, alertsPromptFor } from "./alertsPrompt";

const NOW = Date.parse("2026-10-22T09:00:00Z");
const base = { supported: true, permission: "undetermined" as const, wantAlerts: false, asked: false, lastNudgeAt: null, nowMs: NOW };

describe("when the app asks for notifications", () => {
  it("first open: the welcome card, once", () => {
    expect(alertsPromptFor(base)).toBe("first");
    expect(alertsPromptFor({ ...base, asked: true })).toBeNull();
  });
  it("nothing on the web preview or a simulator", () => {
    expect(alertsPromptFor({ ...base, supported: false })).toBeNull();
  });
  it("blocked in Settings: a reminder to open Settings, at most every few days", () => {
    const denied = { ...base, permission: "denied" as const, asked: true };
    expect(alertsPromptFor(denied)).toBe("settings");
    expect(alertsPromptFor({ ...denied, lastNudgeAt: NOW - 3600_000 })).toBeNull();
    expect(alertsPromptFor({ ...denied, lastNudgeAt: NOW - NUDGE_DAYS * 86_400_000 })).toBe("settings");
  });
  it("allowed by the phone but switched off in the app: a reminder to turn it on", () => {
    const off = { ...base, permission: "allowed" as const, asked: true };
    expect(alertsPromptFor(off)).toBe("enable");
    expect(alertsPromptFor({ ...off, wantAlerts: true })).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  ALERTS_OFF,
  alertsNotice,
  alertsPermission,
  alertsReducer,
  prefsDirty,
  prefsFromServer,
  prefsSaved,
  registrationOutcome,
  setAlertPref,
  type AlertsAction,
  type AlertsState,
} from "./alertsSwitch";
import { DEFAULT_ALERT_PREFS } from "./contract";

const run = (s: AlertsState, ...actions: AlertsAction[]) => actions.reduce(alertsReducer, s);

describe("alertsPermission", () => {
  it("counts granted, iOS provisional and ephemeral as allowed", () => {
    expect(alertsPermission({ status: "granted", granted: true })).toBe("allowed");
    // expo-notifications reports provisional/ephemeral as "undetermined" with the raw iOS status alongside.
    expect(alertsPermission({ status: "undetermined", granted: false, ios: { status: 3 } })).toBe("allowed");
    expect(alertsPermission({ status: "undetermined", granted: false, ios: { status: 4 } })).toBe("allowed");
    expect(alertsPermission({ status: "undetermined", ios: { status: 2 } })).toBe("allowed");
  });
  it("tells denied from not asked yet", () => {
    expect(alertsPermission({ status: "denied", granted: false })).toBe("denied");
    expect(alertsPermission({ status: "undetermined", ios: { status: 1 } })).toBe("denied");
    expect(alertsPermission({ status: "undetermined", ios: { status: 0 } })).toBe("undetermined");
    expect(alertsPermission(null)).toBe("undetermined");
  });
});

describe("registrationOutcome", () => {
  const base = { supported: true, permission: "allowed" as const, token: "ExponentPushToken[abcdefghijklmnop]", serverStatus: 200, tokenAccepted: true };
  it("is ok when the server keeps the token", () => expect(registrationOutcome(base)).toBe("ok"));
  it("has no push on the web or a simulator", () => expect(registrationOutcome({ ...base, supported: false })).toBe("unsupported"));
  it("is blocked without permission", () => {
    expect(registrationOutcome({ ...base, permission: "denied", token: null })).toBe("blocked");
    expect(registrationOutcome({ ...base, permission: "undetermined", token: null })).toBe("blocked");
  });
  it("fails without a push token, unless the phone is offline", () => {
    expect(registrationOutcome({ ...base, token: null, serverStatus: null })).toBe("failed");
    expect(registrationOutcome({ ...base, token: null, online: false, serverStatus: null })).toBe("offline");
  });
  it("waits when the server cannot be reached or is struggling", () => {
    for (const s of [0, 408, 429, 500, 503]) expect(registrationOutcome({ ...base, serverStatus: s })).toBe("offline");
  });
  it("fails when the server refuses the phone or its token", () => {
    expect(registrationOutcome({ ...base, serverStatus: 400 })).toBe("failed");
    expect(registrationOutcome({ ...base, tokenAccepted: false })).toBe("failed");
  });
  it("trusts an older server that does not report on the token", () => {
    expect(registrationOutcome({ ...base, tokenAccepted: undefined })).toBe("ok");
  });
});

describe("alertsReducer", () => {
  it("shows the switch on the moment it is tapped (no snap back while registering)", () => {
    const s = run(ALERTS_OFF, { type: "toggle", on: true });
    expect(s).toEqual({ want: true, status: "turning-on", reason: null });
  });
  it("stays on once registered", () => {
    expect(run(ALERTS_OFF, { type: "toggle", on: true }, { type: "result", outcome: "ok" })).toEqual({ want: true, status: "on", reason: null });
  });
  it("stays on when the server is unreachable, waiting to register again", () => {
    const s = run(ALERTS_OFF, { type: "toggle", on: true }, { type: "result", outcome: "offline" });
    expect(s.want).toBe(true);
    expect(s.status).toBe("waiting");
    expect(alertsNotice(s)?.action).toBe("retry");
  });
  it("goes back off only with a reason the screen shows", () => {
    const blocked = run(ALERTS_OFF, { type: "toggle", on: true }, { type: "result", outcome: "blocked" });
    expect(blocked).toEqual({ want: false, status: "off", reason: "settings" });
    expect(alertsNotice(blocked)).toEqual({ text: "Notifications are off for Move Score in Settings.", action: "settings" });
    const failed = run(ALERTS_OFF, { type: "toggle", on: true }, { type: "result", outcome: "failed" });
    expect(failed).toEqual({ want: false, status: "off", reason: "register" });
    expect(alertsNotice(failed)?.action).toBe("retry");
    expect(alertsNotice(run(ALERTS_OFF, { type: "toggle", on: true }, { type: "result", outcome: "unsupported" }))?.text).toMatch(/phone/);
  });
  it("a background registration hiccup does not turn the switch off", () => {
    const on: AlertsState = { want: true, status: "on", reason: null };
    expect(alertsReducer(on, { type: "result", outcome: "failed" })).toEqual({ want: true, status: "waiting", reason: null });
    expect(alertsReducer(on, { type: "result", outcome: "offline" }).want).toBe(true);
    // ...but notifications blocked in Settings do.
    expect(alertsReducer(on, { type: "result", outcome: "blocked" })).toEqual({ want: false, status: "off", reason: "settings" });
  });
  it("ignores a result that lands after the person turned it off", () => {
    const s = run(ALERTS_OFF, { type: "toggle", on: true }, { type: "toggle", on: false }, { type: "result", outcome: "ok" });
    expect(s).toEqual(ALERTS_OFF);
  });
  it("retrying after a failure turns it on again", () => {
    const s = run(ALERTS_OFF, { type: "toggle", on: true }, { type: "result", outcome: "failed" }, { type: "toggle", on: true }, { type: "result", outcome: "ok" });
    expect(s).toEqual({ want: true, status: "on", reason: null });
    expect(alertsNotice(s)).toBeNull();
  });
  it("carries on turning on when the person comes back from Settings having allowed alerts", () => {
    const blocked = run(ALERTS_OFF, { type: "toggle", on: true }, { type: "result", outcome: "blocked" });
    expect(alertsReducer(blocked, { type: "permission", permission: "allowed" })).toEqual({ want: true, status: "turning-on", reason: null });
    expect(alertsReducer(blocked, { type: "permission", permission: "denied" })).toBe(blocked);
    // A switch turned off by the person is not turned on by the system setting.
    expect(alertsReducer(ALERTS_OFF, { type: "permission", permission: "allowed" })).toBe(ALERTS_OFF);
  });
  it("shows off, with the reason, when alerts were turned off in Settings", () => {
    const on: AlertsState = { want: true, status: "on", reason: null };
    expect(alertsReducer(on, { type: "permission", permission: "denied" })).toEqual({ want: false, status: "off", reason: "settings" });
    expect(alertsReducer(on, { type: "permission", permission: "allowed" })).toBe(on);
  });
  it("loads the saved choice", () => {
    expect(alertsReducer(ALERTS_OFF, { type: "load", stored: true, permission: "allowed" })).toEqual({ want: true, status: "on", reason: null });
    expect(alertsReducer(ALERTS_OFF, { type: "load", stored: false, permission: "allowed" })).toEqual(ALERTS_OFF);
    expect(alertsReducer(ALERTS_OFF, { type: "load", stored: true, permission: "denied" })).toEqual({ want: false, status: "off", reason: "settings" });
    // Installs from before the choice was saved: on whenever the phone allows alerts.
    expect(alertsReducer(ALERTS_OFF, { type: "load", stored: null, permission: "allowed" }).want).toBe(true);
    expect(alertsReducer(ALERTS_OFF, { type: "load", stored: null, permission: "denied" })).toEqual(ALERTS_OFF);
  });
});

describe("alert-type prefs", () => {
  const fresh = { prefs: { ...DEFAULT_ALERT_PREFS }, version: 0, sent: 0 };
  it("a tap sticks even when the first load from the server lands after it", () => {
    const tapped = setAlertPref(fresh, "live", true);
    expect(prefsDirty(tapped)).toBe(true);
    const afterLoad = prefsFromServer(tapped, { ...DEFAULT_ALERT_PREFS, live: false });
    expect(afterLoad.prefs.live).toBe(true);
  });
  it("takes the server's prefs when nothing is waiting to be sent", () => {
    expect(prefsFromServer(fresh, { ...DEFAULT_ALERT_PREFS, major: false }).prefs.major).toBe(false);
  });
  it("only a save of the latest taps clears them", () => {
    const one = setAlertPref(fresh, "live", true);
    const two = setAlertPref(one, "major", false);
    const savedFirst = prefsSaved(two, one.version);
    expect(prefsDirty(savedFirst)).toBe(true);
    expect(prefsDirty(prefsSaved(savedFirst, two.version))).toBe(false);
    // An older save answering late does not undo a newer one.
    expect(prefsSaved(prefsSaved(two, two.version), one.version).sent).toBe(two.version);
  });
});

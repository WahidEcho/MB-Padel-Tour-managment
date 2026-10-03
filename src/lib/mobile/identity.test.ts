import { createHmac } from "crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { deviceHandle, isViewersDevice, mintInstallToken, presentedDeviceId, shownDeviceId, verifyInstallToken } from "./identity";

const SECRET = "test-secret-for-install-tokens";
const ID = "ios-6f1c1a52-3f43-4f0e-9a51-1d2b6c7e8f90";

beforeAll(() => {
  process.env.AUTH_SECRET = SECRET;
});

describe("install tokens", () => {
  it("mints a three-part token that verifies to its installation id", () => {
    const token = mintInstallToken(ID);
    expect(token.split(".")).toHaveLength(3);
    expect(token.startsWith(`${ID}.`)).toBe(true);
    expect(verifyInstallToken(token)).toBe(ID);
  });

  it("uses a fresh nonce every time", () => {
    const a = mintInstallToken(ID);
    const b = mintInstallToken(ID);
    expect(a).not.toBe(b);
    expect(verifyInstallToken(a)).toBe(ID);
    expect(verifyInstallToken(b)).toBe(ID);
  });

  it("refuses the old two-part format, even correctly signed", () => {
    const old = `${ID}.${createHmac("sha256", SECRET).update(`install:${ID}`).digest("base64url")}`;
    expect(verifyInstallToken(old)).toBeNull();
  });

  it("refuses a token moved to another id, a changed nonce or signature, and junk", () => {
    const [, nonce, sig] = mintInstallToken(ID).split(".");
    expect(verifyInstallToken(`android-${ID.slice(4)}.${nonce}.${sig}`)).toBeNull();
    expect(verifyInstallToken(`${ID}.${"A".repeat(22)}.${sig}`)).toBeNull();
    expect(verifyInstallToken(`${ID}.${nonce}.${sig!.slice(0, -2)}xx`)).toBeNull();
    expect(verifyInstallToken(`${ID}.${nonce}.forged`)).toBeNull();
    expect(verifyInstallToken(`${ID}..${sig}`)).toBeNull();
    expect(verifyInstallToken(`${ID}.forged`)).toBeNull();
    expect(verifyInstallToken("")).toBeNull();
    expect(verifyInstallToken(null)).toBeNull();
  });

  it("refuses a token signed with another secret", () => {
    const nonce = "n".repeat(22);
    const sig = createHmac("sha256", "someone-else").update(`install:${ID}:${nonce}`).digest("base64url");
    expect(verifyInstallToken(`${ID}.${nonce}.${sig}`)).toBeNull();
  });
});

describe("shownDeviceId", () => {
  const browser = "0f8fad5b-d9cb-469f-a165-70867728950e";

  it("shows a phone its own id and nobody else", () => {
    expect(shownDeviceId(ID, { installationId: ID, staff: false })).toBe(ID);
    expect(shownDeviceId(ID, { installationId: null, staff: false })).toBe(deviceHandle(ID));
    expect(shownDeviceId(ID, { installationId: null, staff: true })).toBe(deviceHandle(ID));
    expect(shownDeviceId(ID, { installationId: "android-other-install-id", staff: true })).toBe(deviceHandle(ID));
  });

  it("shows staff a web console's browser id, and the public only a handle", () => {
    expect(shownDeviceId(browser, { installationId: null, staff: true })).toBe(browser);
    expect(shownDeviceId(browser, { installationId: null, staff: false })).toBe(deviceHandle(browser));
  });

  it("handles are stable, distinct and do not contain the id", () => {
    expect(deviceHandle(ID)).toBe(deviceHandle(ID));
    expect(deviceHandle(ID)).not.toBe(deviceHandle(browser));
    expect(deviceHandle(ID)).not.toContain(ID.slice(4, 12));
  });
});

describe("a scoring console recognises its own lease", () => {
  it("by the device id it scores with, with no install token (the 'it takes control from me' bug)", () => {
    // A phone whose install token is missing or stale: before, its own lease came back as a handle.
    const viewer = { installationId: null, deviceId: ID, staff: true };
    expect(isViewersDevice(ID, viewer)).toBe(true);
    expect(shownDeviceId(ID, viewer)).toBe(ID);
  });

  it("by its install token, as before", () => {
    expect(isViewersDevice(ID, { installationId: ID, staff: false })).toBe(true);
  });

  it("never as someone else's, and another phone's id stays a handle", () => {
    const viewer = { installationId: null, deviceId: "android-other-install-id", staff: true };
    expect(isViewersDevice(ID, viewer)).toBe(false);
    expect(shownDeviceId(ID, viewer)).toBe(deviceHandle(ID));
    expect(isViewersDevice(ID, { installationId: null, deviceId: null, staff: true })).toBe(false);
    expect(isViewersDevice(ID, { installationId: null, deviceId: "", staff: true })).toBe(false);
  });

  it("reads X-Device-Id, bounded", () => {
    expect(presentedDeviceId(new Headers({ "x-device-id": ` ${ID} ` }))).toBe(ID);
    expect(presentedDeviceId(new Headers())).toBeNull();
    expect(presentedDeviceId(new Headers({ "x-device-id": "x".repeat(101) }))).toBeNull();
  });
});

import { createHmac } from "crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { deviceHandle, mintInstallToken, shownDeviceId, verifyInstallToken } from "./identity";

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

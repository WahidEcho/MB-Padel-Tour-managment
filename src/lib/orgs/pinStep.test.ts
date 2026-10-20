import { describe, expect, it } from "vitest";
import { openEventCode, openPinStep, sealEventCode, sealPinStep, PIN_STEP_SECONDS } from "./codes";

const PEPPER = "p".repeat(40);
const CODE = "K7QMW3XT9HRP";

describe("the web PIN step's sealed cookie (audit L7)", () => {
  it("opens within five minutes of being typed", () => {
    const t = 1_800_000_000_000;
    const sealed = sealPinStep(CODE, t, PEPPER);
    expect(openPinStep(sealed, t + 1000, PEPPER)).toBe(CODE);
    expect(openPinStep(sealed, t + PIN_STEP_SECONDS * 1000, PEPPER)).toBe(CODE);
  });
  it("is refused by the server after five minutes, whatever the cookie's max-age", () => {
    const t = 1_800_000_000_000;
    expect(openPinStep(sealPinStep(CODE, t, PEPPER), t + PIN_STEP_SECONDS * 1000 + 1, PEPPER)).toBeNull();
    expect(openPinStep(sealPinStep(CODE, t + 120_000, PEPPER), t, PEPPER)).toBeNull(); // from the future
  });
  it("never takes a bare sealed code (no issued-at) or another pepper's seal", () => {
    expect(openPinStep(sealEventCode(CODE, PEPPER), Date.now(), PEPPER)).toBeNull();
    expect(openPinStep(sealPinStep(CODE, Date.now(), PEPPER), Date.now(), "q".repeat(40))).toBeNull();
    expect(openEventCode(sealPinStep(CODE, Date.now(), PEPPER), PEPPER)).toBeNull();
  });
});

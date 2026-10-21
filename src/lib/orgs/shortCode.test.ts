import { describe, expect, it } from "vitest";
import { generateShortRefereeCode, normalizeEventCode, generateEventCode, openPinStep, sealPinStep } from "./codes";
import { isShortCode, shortCodeOf, shortCodeQrForm } from "./shortCode";
import { courtLink, parseCourtLink } from "./courtScope";
import { splitCodeAndPin } from "../referees/rules";

describe("short referee codes", () => {
  it("are 2 letters and 2 digits in random positions, without look-alikes", () => {
    const shapes = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const c = generateShortRefereeCode();
      expect(isShortCode(c)).toBe(true);
      expect(c).toMatch(/^[A-HJKMNP-Z2-9]{4}$/);
      expect(c).not.toMatch(/[01OIL]/);
      shapes.add(c.replace(/[A-Z]/g, "L").replace(/\d/g, "D"));
    }
    expect(shapes.size).toBe(6); // every arrangement of 2 letters and 2 digits occurs
  });

  it("read the same in any case, with spaces or dashes, and from the QR form", () => {
    expect(normalizeEventCode("k7p3")).toBe("K7P3");
    expect(normalizeEventCode(" K7-P3 ")).toBe("K7P3");
    expect(normalizeEventCode("k7p3-court-code")).toBe("K7P3");
    expect(normalizeEventCode("K7P3COURTCODE")).toBe("K7P3");
  });

  it("refuse anything that is not exactly 2 letters and 2 digits", () => {
    for (const bad of ["K7P", "K7P33", "KKP3", "K733", "K0P3", "K1P3", "KOP3", "K7P3-COURT", "XYZ1COURTCODE"]) expect(normalizeEventCode(bad)).toBeNull();
    expect(shortCodeOf("K7P3COURTCODEX")).toBeNull();
  });

  it("leave the 12-character codes exactly as before", () => {
    const long = generateEventCode();
    expect(normalizeEventCode(long.toLowerCase())).toBe(long);
    expect(normalizeEventCode(long.slice(0, 11))).toBeNull();
  });

  it("put a QR link the installed apps accept (12–20 characters) and read it back", () => {
    const link = courtLink("https://tour.mbeg.org", "K7P3");
    expect(link).toBe("https://tour.mbeg.org/r#K7P3-COURT-CODE");
    expect(parseCourtLink(link)).toBe(shortCodeQrForm("K7P3"));
    expect(normalizeEventCode(parseCourtLink(link)!)).toBe("K7P3");
    expect(courtLink("https://tour.mbeg.org", "K7QM-W3XT-9HRP")).toBe("https://tour.mbeg.org/r#K7QM-W3XT-9HRP");
  });

  it("split a short code typed with its PIN in one field (the 1.0.1 form)", () => {
    expect(splitCodeAndPin("k7p3 4821")).toEqual({ code: "K7P3", pin: "4821" });
    expect(splitCodeAndPin("K7P3-4821")).toEqual({ code: "K7P3", pin: "4821" });
    expect(splitCodeAndPin("K7P3")).toBeNull();
  });

  it("carry a short code through the web PIN step", () => {
    const now = Date.now();
    expect(openPinStep(sealPinStep("K7P3", now), now)).toBe("K7P3");
  });
});

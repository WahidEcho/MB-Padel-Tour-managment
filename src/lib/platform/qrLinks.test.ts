import { describe, it, expect } from "vitest";
import { normalizeTarget, parseQrLinks } from "./qrLinks";

describe("permanent QR links", () => {
  it("the app code works before anything is saved", () => {
    expect(parseQrLinks(null).app.target).toBe("/app");
  });
  it("takes a saved target over the built-in one, and keeps the built-in code if a bad one is stored", () => {
    expect(parseQrLinks({ app: { target: "https://tour.mbeg.org/t/x" } }).app.target).toBe("https://tour.mbeg.org/t/x");
    expect(parseQrLinks({ app: { target: "javascript:alert(1)" } }).app.target).toBe("/app");
  });
  it("accepts https addresses and site paths only", () => {
    expect(normalizeTarget(" /app/android ")).toBe("/app/android");
    expect(normalizeTarget("https://example.com/a b")).toBeNull();
    expect(normalizeTarget("http://example.com")).toBeNull();
    expect(normalizeTarget("//evil.example")).toBeNull();
    expect(normalizeTarget("https://example.com")).toBe("https://example.com/");
  });
});

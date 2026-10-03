import { describe, expect, it } from "vitest";
import { isStrongPassword, isValidEmail, normalizeEmail, passwordChecks, passwordProblem, PASSWORD_MAX_BYTES } from "./password";

describe("password rules", () => {
  it("accepts a password that meets every rule", () => {
    expect(passwordProblem("Rally2026")).toBeNull();
    expect(isStrongPassword("Rally2026", "fan@example.com")).toBe(true);
  });

  it("needs eight characters", () => {
    expect(passwordProblem("Ra1ly")).toMatch(/at least 8/);
    expect(passwordProblem("Rally202")).toBeNull();
  });

  it("needs a lower-case letter, an upper-case letter and a number", () => {
    expect(passwordProblem("RALLY2026")).toMatch(/lower-case/);
    expect(passwordProblem("rally2026")).toMatch(/upper-case/);
    expect(passwordProblem("RallyRally")).toMatch(/number/);
  });

  it("refuses more than 72 bytes (bcrypt's limit), counting non-ASCII by its bytes", () => {
    expect(passwordProblem(`Aa1${"x".repeat(PASSWORD_MAX_BYTES - 3)}`)).toBeNull();
    expect(passwordProblem(`Aa1${"x".repeat(PASSWORD_MAX_BYTES - 2)}`)).toMatch(/at most 72/);
    expect(passwordProblem(`Aa1${"é".repeat(35)}`)).toMatch(/at most 72/); // 3 + 70 bytes
  });

  it("refuses the email address itself, whatever its case", () => {
    expect(passwordProblem("Fan1@Example.com", "fan1@example.com")).toMatch(/email/);
    expect(passwordProblem("Fan1@Example.com", "other@example.com")).toBeNull();
    expect(passwordProblem("Fan1@Example.com", null)).toBeNull();
  });

  it("lists each rule with whether it is met, for the app's live checklist", () => {
    const checks = passwordChecks("abc");
    expect(checks.map((c) => c.rule)).toEqual(["length", "lower", "upper", "digit", "max", "notEmail"]);
    expect(checks.filter((c) => c.ok).map((c) => c.rule)).toEqual(["lower", "max", "notEmail"]);
  });
});

describe("email", () => {
  it("normalises case and spaces", () => {
    expect(normalizeEmail("  Fan@Example.COM ")).toBe("fan@example.com");
  });
  it("accepts ordinary addresses and refuses obvious mistakes", () => {
    expect(isValidEmail("fan@example.com")).toBe(true);
    expect(isValidEmail("first.last+tag@mail.example.co.uk")).toBe(true);
    for (const bad of ["", "fan", "fan@", "@example.com", "fan@example", "fan @example.com", "fan@@example.com", "fan@example..com"]) {
      expect(isValidEmail(bad), bad).toBe(false);
    }
    expect(isValidEmail(`${"a".repeat(250)}@x.io`)).toBe(false);
  });
});

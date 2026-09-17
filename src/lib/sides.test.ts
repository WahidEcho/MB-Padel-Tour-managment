import { describe, expect, it } from "vitest";
import { SIDES, redBlueTeams, sideTint } from "./sides";

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const channel = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

describe("red and blue teams", () => {
  it("makes the first-listed team Red and the second Blue", () => {
    expect(SIDES.A.label).toBe("Red team");
    expect(SIDES.B.label).toBe("Blue team");
  });

  it("keeps white labels readable on both colours", () => {
    for (const side of Object.values(SIDES)) {
      const contrast = (1 + 0.05) / (luminance(side.hex) + 0.05);
      expect(contrast, side.label).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("tints each side's colour", () => {
    expect(sideTint("A", 0.16)).toBe("rgba(220, 38, 38, 0.16)");
    expect(sideTint("B", 2)).toBe("rgba(37, 99, 235, 1)");
  });

  it("is off unless the organiser turns it on", () => {
    expect(redBlueTeams({})).toBe(false);
    expect(redBlueTeams(null)).toBe(false);
    expect(redBlueTeams({ redBlueTeams: true })).toBe(true);
  });
});

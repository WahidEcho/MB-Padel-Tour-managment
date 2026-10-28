import { describe, expect, it } from "vitest";
import { displayWidthEm, headlineSize } from "./headline";
import { story as en } from "../i18n/en/story";
import { story as es } from "../i18n/es/story";
import { story as fr } from "../i18n/fr/story";

const heads = (pack: Record<string, string>) => Object.entries(pack).filter(([k]) => k.startsWith("head")).map(([, v]) => v.split("|"));

describe("headlineSize", () => {
  it("shrinks COMING so it stays on one line of the Minimal sticker", () => {
    const size = headlineSize(["Coming", "up"], 312, 62);
    expect(size).toBeLessThan(62);
    expect(displayWidthEm("Coming") * size).toBeLessThanOrEqual(312);
  });

  it("keeps the full size when the words already fit", () => {
    expect(headlineSize(["Tie", "won"], 312, 62)).toBe(62);
  });

  it("fits every headline word in every language on every card", () => {
    for (const pack of [en, es, fr]) {
      for (const words of heads(pack)) {
        for (const [width, max] of [[312, 62], [234, 44], [72, 13]] as const) {
          const size = headlineSize(words, width, max);
          for (const w of words) expect(displayWidthEm(w) * size, `${w} at ${width}`).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it("measures accented capitals like their letter", () => {
    expect(displayWidthEm("gagnée")).toBeCloseTo(displayWidthEm("GAGNEE"));
  });
});

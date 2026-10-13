import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SCORING_CONFIG, DEFAULT_TENNIS_SCORING_CONFIG } from "../types";
import { SPORTS, sportOf } from "./registry";

describe("sportOf", () => {
  it("knows padel, tennis and chess", () => {
    expect(sportOf({ sport: "padel" })).toBe(SPORTS.padel);
    expect(sportOf({ sport: "tennis" }).defaultRules).toBe(DEFAULT_TENNIS_SCORING_CONFIG);
    expect(sportOf("chess").engine).toBe("chess");
    expect(sportOf("chess").nouns.match).toBe("Game");
    expect(sportOf("tennis").supports.ties).toBe(true);
    expect(sportOf("padel").supports.ties).toBe(false);
  });

  it("falls back to a generic games sport", () => {
    for (const t of [null, undefined, {}, { sport: null }, { sport: "" }]) {
      const s = sportOf(t);
      expect(s.engine).toBe("games");
      expect(s.id).toBe("games");
      expect(s.defaultRules).toBe(DEFAULT_SCORING_CONFIG);
    }
    const squash = sportOf({ sport: "Squash" });
    expect(squash.id).toBe("squash");
    expect(squash.label).toBe("Squash");
    expect(squash.supports.voice).toBe(false);
  });

  it("is case and space tolerant", () => {
    expect(sportOf(" Tennis ")).toBe(SPORTS.tennis);
  });
});

/**
 * Ratchet: string comparisons on `sport` under src/ may only go down. Move a
 * branch onto sportOf() and lower the ceiling; never raise it.
 */
const CEILING = 31;
const BRANCH = /\bsport (===|!==) "/g;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("sport branches ratchet", () => {
  it(`keeps \`sport === "…"\` branches at or below ${CEILING}`, () => {
    const root = join(__dirname, "..", "..");
    let n = 0;
    for (const f of sources(root)) n += (readFileSync(f, "utf8").match(BRANCH) ?? []).length;
    expect(n, "new sport string branch: use sportOf() from src/lib/sports/registry").toBeLessThanOrEqual(CEILING);
  });
});

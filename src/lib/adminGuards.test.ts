import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every mutating server action under the tournament admin pages must refuse a
 * friendly session's hidden row, or be on the short list of tools sessions
 * legitimately share. This reads the action files themselves, so an action added
 * later without a guard fails here instead of quietly reaching a session's data.
 *
 * The guards' behaviour against real rows is exercised by scripts/e2e/cup-plate.ts;
 * this only checks that each action calls one.
 */

const ROOT = join(__dirname, "..", "app", "admin", "tournaments");

/** Anything that refuses a session's row, directly or through a guarded operation. */
const GUARDS = [
  "tournamentRowRefusal(",
  "entityRefusal(",
  "groupDrawLock(",
  "runGroupStageRegeneration(",
  "redrawBracket(",
  "approveBracket(",
  "resetBracketTier(",
  "deleteTournamentRow(",
  "deleteManualMatch(",
  "resetTournamentLiveData(",
];

/** Actions that are shared with sessions, create a new tournament, or only read. */
const ALLOWED_UNGUARDED: Record<string, string> = {
  createTournament: "creates a new tournament row",
  seedDemoTournament: "creates a new demo tournament row",
  addCourt: "shared with sessions: a session's wall needs its courts",
  saveBranding: "shared with sessions: a session's wall uses its branding",
  drawOptions: "read-only: proposes draws without saving",
  listBrackets: "read-only",
};

/** Shared with sessions, but still only for the posted tournament's own rows. */
const OWNERSHIP_ONLY: Record<string, string> = {
  releaseScoringLock: "a stuck tablet is the same problem on a session",
};

function actionFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return actionFiles(path);
    return name === "actions.ts" || name === "demo.ts" ? [path] : [];
  });
}

/**
 * Exported async functions and their bodies. A body ends at its own closing brace
 * in column 0, so a helper declared after it can never lend it a guard.
 */
function exportedActions(source: string): { name: string; body: string }[] {
  return [...source.matchAll(/^export async function (\w+)/gm)].map((m) => {
    const end = source.indexOf("\n}\n", m.index);
    return { name: m[1], body: source.slice(m.index, end === -1 ? source.length : end + 2) };
  });
}

/** Where the body first writes or reads through the database directly, or -1. */
function firstDirectDbCall(body: string): number {
  return body.indexOf("db()");
}

describe("tournament admin actions refuse a friendly session's hidden row", () => {
  const files = actionFiles(ROOT);

  it("finds the action files", () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  for (const file of files) {
    const rel = file.slice(ROOT.length + 1);
    for (const { name, body } of exportedActions(readFileSync(file, "utf8"))) {
      it(`${rel} › ${name}`, () => {
        if (ALLOWED_UNGUARDED[name]) return;
        const dbAt = firstDirectDbCall(body);
        if (OWNERSHIP_ONLY[name]) {
          const at = body.indexOf("ownershipRefusal(");
          expect(at, `${name} must check the match belongs to the posted tournament`).toBeGreaterThan(-1);
          if (dbAt !== -1) expect(at, `${name} must check ownership before touching the database`).toBeLessThan(dbAt);
          return;
        }
        const positions = GUARDS.map((g) => body.indexOf(g)).filter((i) => i !== -1);
        expect(positions.length > 0, `${name} in ${rel} changes data without refusing a session's row`).toBe(true);
        if (dbAt !== -1) {
          expect(Math.min(...positions), `${name} in ${rel} touches the database before refusing a session's row`).toBeLessThan(dbAt);
        }
      });
    }
  }
});

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Source scans for the two guard layers of the staff console.
 *
 * 1. Every mutating server action under the tournament admin pages must refuse a
 *    friendly session's hidden row, or be on the short list of tools sessions
 *    legitimately share. (Behaviour against real rows: scripts/e2e/cup-plate.ts.)
 * 2. Organisations (migration 0023): every staff action, page and route resolves
 *    the organisation from the row it touches (src/lib/guard.ts) before it reaches
 *    any data, lists are filtered by organisation, and nothing uses the old
 *    unscoped role checks. (Behaviour: scripts/e2e/organizations.ts.)
 *
 * Reading the files themselves means an action, page or route added later
 * without a guard fails here instead of quietly reaching another organisation.
 */

const APP = join(__dirname, "..", "app");
const ROOT = join(APP, "admin", "tournaments");

function walk(dir: string, keep: (name: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path, keep);
    return keep(name) ? [path] : [];
  });
}
const rel = (path: string) => relative(APP, path);

/* ---------------- 1. friendly sessions' hidden rows ---------------- */

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
  prepareBackgroundUpload: "shared with sessions: part of the branding a session's wall uses",
  finishBackgroundUpload: "shared with sessions: part of the branding a session's wall uses",
  drawOptions: "read-only: proposes draws without saving",
  listBrackets: "read-only",
};

/** Shared with sessions, but still only for the posted tournament's own rows. */
const OWNERSHIP_ONLY: Record<string, string> = {
  releaseScoringLock: "a stuck tablet is the same problem on a session",
};

/** Settings sessions run by too: any tournament or session row, but nothing else. */
const SESSION_AWARE: Record<string, string> = {
  saveMatchDayRules: "sessions have match-day rules too",
};

function actionFiles(dir: string): string[] {
  return walk(dir, (name) => name === "actions.ts" || name === "demo.ts");
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
    const name0 = file.slice(ROOT.length + 1);
    for (const { name, body } of exportedActions(readFileSync(file, "utf8"))) {
      it(`${name0} › ${name}`, () => {
        if (ALLOWED_UNGUARDED[name]) return;
        const dbAt = firstDirectDbCall(body);
        if (OWNERSHIP_ONLY[name]) {
          const at = body.indexOf("ownershipRefusal(");
          expect(at, `${name} must check the match belongs to the posted tournament`).toBeGreaterThan(-1);
          if (dbAt !== -1) expect(at, `${name} must check ownership before touching the database`).toBeLessThan(dbAt);
          return;
        }
        if (SESSION_AWARE[name]) {
          const at = body.indexOf("tournamentOrSessionRefusal(");
          expect(at, `${name} must refuse rows that are neither a tournament nor a session`).toBeGreaterThan(-1);
          if (dbAt !== -1) expect(at, `${name} must refuse before touching the database`).toBeLessThan(dbAt);
          return;
        }
        const positions = GUARDS.map((g) => body.indexOf(g)).filter((i) => i !== -1);
        expect(positions.length > 0, `${name} in ${name0} changes data without refusing a session's row`).toBe(true);
        if (dbAt !== -1) {
          expect(Math.min(...positions), `${name} in ${name0} touches the database before refusing a session's row`).toBeLessThan(dbAt);
        }
      });
    }
  }
});

/* ---------------- 2. organisations ---------------- */

/** Guards that resolve the organisation from the row itself (src/lib/guard.ts), or check a player against it. */
const SCOPED_GUARDS = [
  "requireTournamentPermission(",
  "requireScopedPermission(",
  "requireOrgPermission(",
  "requirePlatformPermission(",
  // src/app/admin/players/actions.ts: the profile must be one of the organisation's players.
  "requireOwnProfile(",
  "profileInOrg(",
];

/**
 * Actions that name no existing row: they create something new in the staff
 * member's own organisation (and stamp `staff.orgId` on it), or act on the
 * organisation as a whole. Any row they do name is checked with a scoped guard.
 */
const ORG_LEVEL: Record<string, string> = {
  createTournament: "new tournament in the caller's organisation",
  seedDemoTournament: "new demo tournament in the caller's organisation",
  createSeason: "new season in the caller's organisation",
  createSessionAction: "new session in the caller's organisation (its season is scope-checked)",
  createPlayerProfile: "new player of the caller's organisation",
  previewAction: "audience checked by requireOwnAudience, resolved inside the organisation",
  sendTestAction: "audience checked by requireOwnAudience, resolved inside the organisation",
  createAndSendAction: "audience checked by requireOwnAudience; the announcement is stamped with the organisation",
  refreshTemplatesAction: "reads the WhatsApp template list only",
  createEventCode: "new code in the caller's organisation (its tournament is scope-checked)",
  inviteMember: "new invite into the caller's organisation (never one named in the form)",
};

/** Data helpers that read or write rows, besides db() itself. */
const DATA_CALLS = ["db()", "getTournament(", "getSession(", "getMatch(", "getTeams(", "getCourts(", "recipientsOf(", "mergePlayerProfiles("];

function firstDataCall(body: string): number {
  const at = DATA_CALLS.map((c) => body.indexOf(c)).filter((i) => i !== -1);
  return at.length ? Math.min(...at) : -1;
}

const staffActionFiles = [...actionFiles(join(APP, "admin")), ...actionFiles(join(APP, "operator"))];

describe("every staff action resolves the organisation from the row it touches", () => {
  it("finds the staff action files", () => {
    expect(staffActionFiles.length).toBeGreaterThanOrEqual(15);
  });

  for (const file of staffActionFiles) {
    for (const { name, body } of exportedActions(readFileSync(file, "utf8"))) {
      it(`${rel(file)} › ${name}`, () => {
        const scoped = SCOPED_GUARDS.map((g) => body.indexOf(g)).filter((i) => i !== -1);
        const orgLevel = body.indexOf("requireStaffPermission(");
        const dataAt = firstDataCall(body);
        if (ORG_LEVEL[name]) {
          expect(orgLevel, `${name} must check the staff member's permission first`).toBeGreaterThan(-1);
          if (dataAt !== -1) expect(orgLevel, `${name} must check before reaching data`).toBeLessThan(dataAt);
          // Whatever it creates is stamped with the caller's organisation, or it names no row at all.
          const stamps = /organization_id: staff\.orgId|organizationId: staff\.orgId|requireOwnAudience\(|whatsappTemplates\(/.test(body);
          expect(stamps, `${name} must stamp what it creates with staff.orgId`).toBe(true);
          return;
        }
        expect(scoped.length > 0, `${name} in ${rel(file)} reaches data without resolving the organisation from the row`).toBe(true);
        if (dataAt !== -1) {
          expect(Math.min(...scoped), `${name} in ${rel(file)} reaches data before the organisation guard`).toBeLessThan(dataAt);
        }
      });
    }
  }
});

const sources = walk(APP, (name) => /\.(ts|tsx)$/.test(name)).map((path) => ({ path, text: readFileSync(path, "utf8") }));

describe("nothing uses the old unscoped role checks", () => {
  for (const { path, text } of sources) {
    if (!/requirePermission\(|currentRole\(/.test(text)) continue;
    it(`${rel(path)} uses requirePermission/currentRole`, () => {
      expect(text, "use the organisation-scoped guards in src/lib/guard.ts").not.toMatch(/requirePermission\(|currentRole\(/);
    });
  }
  it("guard.ts no longer exports requirePermission", () => {
    expect(readFileSync(join(__dirname, "guard.ts"), "utf8")).not.toMatch(/export async function requirePermission\b/);
  });
});

const PAGE_GUARDS = ["requireStaff(", "requireEntityPage(", "requireTournamentPage(", "requirePlatformPage("];
const ROW_PAGE_GUARDS = ["requireEntityPage(", "requireTournamentPage("];
/** Staff pages with no data of their own. */
const PAGE_EXEMPT: Record<string, string> = {
  "admin/page.tsx": "redirects to /admin/tournaments",
  "admin/tournaments/new/page.tsx": "a client form; createTournament checks",
  "staff/orgs/page.tsx": "lists the signed-in member's own organisations (currentStaff + staffOrgsFor)",
};

describe("every staff page checks the organisation itself (a layout is not re-run on navigation)", () => {
  const pages = sources.filter(({ path }) => /^(admin|operator|referee|staff|qr|venue)\//.test(rel(path)) && path.endsWith("page.tsx"));
  it("finds the staff pages", () => {
    expect(pages.length).toBeGreaterThanOrEqual(35);
  });
  for (const { path, text } of pages) {
    const r = rel(path);
    if (PAGE_EXEMPT[r]) continue;
    it(r, () => {
      expect(PAGE_GUARDS.some((g) => text.includes(g)), `${r} has no page guard`).toBe(true);
      // A page for one row ([id], [matchId], [slug]) must resolve that row's organisation.
      if (/\[(id|matchId|slug)\]/.test(r)) {
        expect(ROW_PAGE_GUARDS.some((g) => text.includes(g)), `${r} must use requireTournamentPage / requireEntityPage`).toBe(true);
      }
    });
  }
});

describe("every staff route checks the organisation of the row it serves", () => {
  const routes = sources.filter(({ path }) => {
    const r = rel(path);
    if (!r.endsWith("route.ts")) return false;
    return (
      (r.startsWith("api/matches/") && !r.includes("checkin-qr")) ||
      r.startsWith("api/mobile/v1/referee/") ||
      /^api\/(tournaments|f)\/\[[a-z]+\]\/export\//.test(r) ||
      r.startsWith("admin/")
    );
  });
  it("finds the staff routes", () => {
    expect(routes.length).toBeGreaterThanOrEqual(13);
  });
  for (const { path, text } of routes) {
    it(rel(path), () => {
      const at = ["staffRoute(", "staffReaching("].map((g) => text.indexOf(g)).filter((i) => i !== -1);
      expect(at.length > 0, `${rel(path)} has no staffRoute/staffReaching guard`).toBe(true);
    });
  }
});

/** Tables an organisation owns directly, and the column that scopes a child list. */
const ORG_TABLES = [
  "tournaments",
  "event_groups",
  "seasons",
  "ranking_categories",
  "message_announcements",
  "organization_codes",
  "organizations",
  "organization_members",
  "organization_invites",
];

/** Line comments blanked out (same length), so a ";" in a comment never ends a statement. */
const code = (text: string) => text.replace(/\/\/[^\n]*/g, (c) => " ".repeat(c.length));

describe("staff lists are filtered by organisation", () => {
  // Platform pages (Move Beyond's, platform admins only) see every organisation on purpose.
  const scoped = sources.filter(({ path }) => /^(admin|operator|referee|api\/mobile\/v1\/referee)\//.test(rel(path)) && !rel(path).startsWith("admin/platform/"));
  for (const { path, text: raw } of scoped) {
    const text = code(raw);
    const statements = [...text.matchAll(/\.from\("([a-z_]+)"\)/g)]
      .filter((m) => ORG_TABLES.includes(m[1]) || m[1] === "friendly_sessions")
      .map((m) => {
        const rest = text.slice(m.index);
        const stop = [rest.indexOf(";"), rest.indexOf("db()", 5)].filter((i) => i !== -1);
        return { table: m[1], chain: rest.slice(0, stop.length ? Math.min(...stop) : rest.length) };
      });
    if (statements.length === 0) continue;
    it(rel(path), () => {
      for (const { table, chain } of statements) {
        const ok =
          /organization_id/.test(chain) ||
          /\.eq\("(id|slug)"/.test(chain) ||
          (table === "friendly_sessions" && /tournament_id|season_id/.test(chain));
        expect(ok, `${rel(path)}: .from("${table}") without an organisation filter (or a single-row id lookup):\n${chain.slice(0, 200)}`).toBe(true);
      }
    });
  }
});

/* ---------------- 3. every posted secondary id is checked ---------------- */

/**
 * The organisation guard on the posted tournament proves nothing about any other
 * id the form posts (a tie, a team, a court, a profile…): a request can pair one's
 * own tournament id with another organisation's row id. So every posted id other
 * than `tournament_id` must be an argument of a guard that checks that row itself,
 * or be on the list below with the reason it is safe. Behaviour:
 * scripts/e2e/organizations.ts.
 */
const SECONDARY_GUARDS = [
  // The posted organisation id must be the caller's own (src/lib/guard.ts).
  "requireOrgPermission",
  "ownershipRefusal",
  "entityRefusal",
  "requireScopedPermission",
  "requireTournamentPermission",
  "requireOwnProfile",
  "profileInOrg",
  "requireOwnPlayers",
  "playerIn",
  "deleteManualMatch",
];

/** `file › action › key` → why that posted id needs no row guard of its own. */
const SECONDARY_ID_ALLOWED: Record<string, string> = {
  "admin/friendly-sessions/actions.ts › approveEntryAction › session_id": "only used to revalidate the page; the entry decides the organisation",
  "admin/friendly-sessions/actions.ts › releaseEntryAction › session_id": "only used to revalidate the page; the entry decides the organisation",
  "admin/tournaments/[id]/players/actions.ts › sendCode › player_id": "looked up together with .eq(\"tournament_id\", id) on the guarded tournament",
  "admin/tournaments/[id]/ties/actions.ts › delayOrderOfPlayAction › court_id": "only an extra filter on this tournament's own ties and rubbers (delayOrderOfPlay); never written",
  "admin/platform/organizations/actions.ts › decideApplication › org_id": "platform admins (requirePlatformPermission) act on every organisation",
  "admin/platform/organizations/actions.ts › setOrganizationStatus › org_id": "platform admins (requirePlatformPermission) act on every organisation",
  "admin/platform/organizations/actions.ts › inviteToOrganization › org_id": "platform admins (requirePlatformPermission) act on every organisation",
  "admin/platform/organizations/actions.ts › saveBilling › org_id": "platform admins (requirePlatformPermission) act on every organisation",
  "admin/platform/organizations/actions.ts › decideRename › org_id": "platform admins (requirePlatformPermission) act on every organisation",
};

// (The screen controls' court ids are read in operator/…/control/actions.ts's helper
// patchFrom, which keeps only this tournament's own courts from getCourts.)

const SECONDARY_KEY = /^(id|[a-z_]+_ids?)$/;

/** [start, end) of each guard call's argument list, parentheses balanced. */
function guardSpans(body: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const g of SECONDARY_GUARDS) {
    for (const m of body.matchAll(new RegExp(`\\b${g}\\(`, "g"))) {
      const start = m.index + m[0].length;
      let depth = 1;
      let i = start;
      while (i < body.length && depth > 0) {
        if (body[i] === "(") depth++;
        else if (body[i] === ")") depth--;
        i++;
      }
      spans.push([start, i]);
    }
  }
  return spans;
}

describe("every posted secondary id passes through a row guard", () => {
  const seen = new Set<string>();
  for (const file of staffActionFiles) {
    for (const { name, body } of exportedActions(readFileSync(file, "utf8"))) {
      const spans = guardSpans(body);
      const inGuard = (at: number) => spans.some(([s, e]) => at >= s && at < e);
      for (const m of body.matchAll(/formData\.get(?:All)?\("([a-z_]+)"\)/g)) {
        const key = m[1];
        if (key === "tournament_id" || !SECONDARY_KEY.test(key)) continue;
        const label = `${rel(file)} › ${name} › ${key}`;
        seen.add(label);
        it(label, () => {
          if (SECONDARY_ID_ALLOWED[label]) return;
          if (inGuard(m.index)) return;
          // `const x = …formData.get("key")…` → x itself must reach a guard.
          const lineStart = body.lastIndexOf("\n", m.index) + 1;
          const decl = /^\s*(?:const|let)\s+(\w+)\s*=/.exec(body.slice(lineStart, m.index));
          const name0 = decl?.[1];
          const guarded =
            !!name0 && [...body.matchAll(new RegExp(`\\b${name0}\\b`, "g"))].some((u) => u.index > m.index && inGuard(u.index));
          expect(guarded, `${label}: a posted id must be checked with ownershipRefusal/entityRefusal (or a scoped guard) before use, or be on SECONDARY_ID_ALLOWED with a reason`).toBe(true);
        });
      }
    }
  }
  it("the allow-list names only ids that are still posted", () => {
    for (const label of Object.keys(SECONDARY_ID_ALLOWED)) expect(seen.has(label), `stale SECONDARY_ID_ALLOWED entry: ${label}`).toBe(true);
  });
});

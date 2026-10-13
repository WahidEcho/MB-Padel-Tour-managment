/**
 * Organisations, attacked (Phase 0.5, part A). Two organisations, A and B. Org A's
 * admin (signed in for real through the web Google flow), manager, referee (event
 * code, bearer) and screen operator (scoped event code, cookie) — and Move
 * Beyond's shared admin password — each try to read, edit, score, export and
 * message org B's data through admin pages, server actions (called the way the
 * browser calls them), API routes, direct match ids, event-group ids and
 * announcement ids. Every attempt must be refused with none of B's data in the
 * response, and B's rows must be unchanged. Forged, expired and wrongly signed
 * tokens, revoked and expired codes, a removed member and a suspended
 * organisation are refused on the next request. Move Beyond's backfill is checked.
 *
 * Also (security review of 2e4e58a): B's ties, groups, bracket slots, nations,
 * leaderboard rows, courts and teams named alongside A's own tournament id; a
 * public registration form pulling B's player into A (A must not see their
 * contact fields nor reach them in audiences); merges and consents; event codes
 * scoped to one tournament against another tournament of the same organisation;
 * the shared admin password on platform pages; multi-byte signatures (401, not
 * 500); per-address login brakes; the __Host- staff cookie off localhost; and the
 * database refusing a code scoped to another organisation's tournament.
 *
 * Stand-in only; creates and deletes its own data.
 *
 *   npm run localdb                                   # terminal 1
 *   npm run build                                     # with no `next dev` running
 *   (set -a; . ./.env.localdb; set +a; PUBLIC_SITE_URL=http://localhost:3077 npx next start -p 3077)
 *   npm run e2e:organizations
 *
 * Needs the server's STAFF_SESSION_SECRET in .env.localdb, and `.next/` from the
 * build the server runs (server action ids are read from its manifest).
 */
import { createHash, randomBytes, randomUUID } from "crypto";
import { readFileSync } from "fs";
import { request as httpRequest } from "http";
import { join } from "path";
import { db } from "../../src/lib/supabase";
import { addEntryForProfile, createFriendlySession, generateSchedule } from "../../src/lib/friendly/ops";
import { formatEventCode, generateEventCode, hashEventCode } from "../../src/lib/orgs/codes";
import { signStaffToken } from "../../src/lib/auth/staffToken";
import { BASE_URL, sessionToken, staffToken } from "./lib/session";

const SUPA = process.env.SUPABASE_URL ?? "";
if (!/localhost|127\.0\.0\.1/.test(SUPA)) throw new Error("organizations.ts runs against the local stand-in only");
if (!process.env.STAFF_SESSION_SECRET) throw new Error("STAFF_SESSION_SECRET must be set (the server's, in .env.localdb)");

let failed = 0;
let passed = 0;
function check(ok: boolean, label: string, detail?: unknown) {
  if (ok) passed++;
  else failed++;
  if (!ok || process.env.VERBOSE) console.log(`${ok ? "✅" : "❌"} ${label}${detail !== undefined ? ` — ${typeof detail === "string" ? detail.slice(0, 300) : JSON.stringify(detail).slice(0, 300)}` : ""}`);
}
const section = (s: string) => console.log(`\n— ${s}`);

type Who = { label: string; headers: Record<string, string> };
const cookie = (token: string): Record<string, string> => ({ Cookie: `mb_session=${token}` });
const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

async function http(method: string, path: string, who: Record<string, string> = {}, body?: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    redirect: "manual",
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...who },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: res.status, text, json, location: res.headers.get("location") ?? "" };
}

/**
 * A GET with a chosen Host header (fetch refuses to set Host): how the server
 * behaves off localhost, e.g. which staff cookie it sets and reads.
 */
function rawGet(path: string, host: string, headers: Record<string, string> = {}): Promise<{ status: number; location: string; setCookie: string[] }> {
  const u = new URL(`${BASE_URL}${path}`);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method: "GET", headers: { ...headers, Host: host } }, (res) => {
      res.resume();
      res.on("end", () => {
        const sc = res.headers["set-cookie"];
        resolve({ status: res.statusCode ?? 0, location: String(res.headers.location ?? ""), setCookie: Array.isArray(sc) ? sc : sc ? [sc] : [] });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/* ---------------- server actions, called the way the browser does ---------------- */

interface ManifestEntry {
  filename: string;
  exportedName: string;
  workers: Record<string, unknown>;
}
const manifest = JSON.parse(readFileSync(join(process.cwd(), ".next/server/server-reference-manifest.json"), "utf8")) as { node: Record<string, ManifestEntry> };

/** The attacker's own rows, to fill a page path the action is posted to (it must be a page that uses the action). */
let ownParams: { tournament: string; session: string; announcement: string; match: string } = { tournament: "x", session: "x", announcement: "x", match: "x" };
function actionTarget(file: string, name: string): { id: string; page: string } {
  const hit = Object.entries(manifest.node).find(([, e]) => e.filename === file && e.exportedName === name);
  if (!hit) throw new Error(`no server action ${file}#${name} in the build manifest (rebuild?)`);
  // The page with the fewest dynamic segments, filled with the attacker's own ids.
  const worker = Object.keys(hit[1].workers).sort((a, b) => a.split("[").length - b.split("[").length)[0]!;
  const page =
    worker
      .replace(/^app/, "")
      .replace(/\/page$/, "")
      .replace(/friendly-sessions\/\[id\]/, `friendly-sessions/${ownParams.session}`)
      .replace(/announcements\/\[id\]/, `announcements/${ownParams.announcement}`)
      .replace(/\[matchId\]/, ownParams.match)
      .replace(/\[screenKey\]/, "main")
      .replace(/\[id\]/, ownParams.tournament) || "/";
  return { id: hit[0], page };
}

/** Calls a server action with the React reply encoding (JSON args, or a multipart body for FormData args). */
async function action(file: string, name: string, args: unknown[], who: Record<string, string>) {
  const { id, page } = actionTarget(file, name);
  let body: string | FormData;
  const headers: Record<string, string> = { "Next-Action": id, Accept: "text/x-component", Origin: BASE_URL, ...who };
  if (args.some((a) => a instanceof FormData)) {
    const fd = new FormData();
    let n = 1;
    const model = args.map((a) => {
      if (!(a instanceof FormData)) return a === undefined ? "$undefined" : a;
      const k = n++;
      a.forEach((v, key) => fd.append(`_${k}_${key}`, v));
      return `$K${k.toString(16)}`;
    });
    fd.set("0", JSON.stringify(model));
    body = fd;
  } else {
    body = JSON.stringify(args);
    headers["Content-Type"] = "text/plain;charset=UTF-8";
  }
  const res = await fetch(`${BASE_URL}${page}`, { method: "POST", headers, body, redirect: "manual" });
  return { status: res.status, text: await res.text() };
}
const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.append(k, v);
  return f;
};
/** An action that did its work answers 200 (or a 303 redirect) without an error in its payload. */
const actionOk = (r: { status: number; text: string }) => (r.status === 200 || r.status === 303) && !/"digest"|Not found|Not allowed/.test(r.text);
/** Refused: an error, or a (state, form) action answering { ok: false }. */
const actionRefused = (r: { status: number; text: string }) => !actionOk(r) || /"ok":false/.test(r.text);

/* ---------------- the stand-in's Supabase Auth ---------------- */

/** A stand-in user signed in "with Google" directly, to learn their user id (and get a user JWT). */
async function standinUser(email: string): Promise<{ id: string; accessToken: string }> {
  const verifier = randomBytes(40).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const a = await fetch(
    `${SUPA}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent("http://localhost/e2e")}&code_challenge=${challenge}&code_challenge_method=s256&login_hint=${encodeURIComponent(email)}`,
    { redirect: "manual" },
  );
  const code = new URL(a.headers.get("location")!).searchParams.get("code");
  const t = await fetch(`${SUPA}/auth/v1/token?grant_type=pkce`, {
    method: "POST",
    headers: { apikey: process.env.SUPABASE_KEY ?? "", "Content-Type": "application/json" },
    body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
  });
  const j = (await t.json()) as { access_token: string; user: { id: string } };
  return { id: j.user.id, accessToken: j.access_token };
}

/** The web staff sign-in with Google, through this server's own routes. Returns the staff cookie value. */
async function webGoogleSignIn(email: string, next = "/admin/tournaments"): Promise<{ token: string | null; landed: string }> {
  const start = await fetch(`${BASE_URL}/staff/auth/google?next=${encodeURIComponent(next)}`, { redirect: "manual" });
  const state = (start.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("mb_staff_oauth="))?.split(";")[0] ?? "";
  const authorize = new URL(start.headers.get("location") ?? "");
  authorize.searchParams.set("login_hint", email);
  const back = await fetch(authorize, { redirect: "manual" });
  const cb = await fetch(back.headers.get("location") ?? "", { redirect: "manual", headers: { Cookie: state } });
  const staff = (cb.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("mb_session="))?.split(";")[0]?.slice("mb_session=".length) ?? null;
  return { token: staff, landed: cb.headers.get("location") ?? "" };
}

/* ---------------- fixtures ---------------- */

async function main() {
  const tag = randomUUID().slice(0, 6);
  const created = { orgs: [] as string[], tournaments: [] as string[], profiles: [] as string[], groups: [] as string[], seasons: [] as string[], announcements: [] as string[], sessions: [] as string[], mbMembers: [] as string[] };

  section("Move Beyond backfill");
  const { data: mbRow } = await db().from("organizations").select("id, status").eq("slug", "move-beyond").maybeSingle();
  const MB = (mbRow as { id: string; status: string } | null)?.id ?? "";
  check(Boolean(MB) && (mbRow as { status: string }).status === "approved", "the Move Beyond organisation exists and is approved");
  const { count: orphanTournaments } = await db().from("tournaments").select("id", { count: "exact", head: true }).is("organization_id", null);
  check(orphanTournaments === 0, "every tournament belongs to an organisation", orphanTournaments);
  for (const table of ["event_groups", "seasons", "ranking_categories", "message_announcements"]) {
    const { count } = await db().from(table).select("id", { count: "exact", head: true }).is("organization_id", null);
    check(count === 0, `every ${table} row belongs to an organisation`, count);
  }
  const { count: lifetimeOrphans } = await db().from("friendly_ranking_snapshots").select("id", { count: "exact", head: true }).eq("scope", "lifetime").is("scope_id", null);
  check(lifetimeOrphans === 0, "lifetime rankings are per organisation (none left platform-wide)", lifetimeOrphans);
  const { data: legacyT } = await db().from("tournaments").insert({ name: `E2E Legacy ${tag}`, slug: `e2e-legacy-${tag}` }).select("id, organization_id").single();
  created.tournaments.push((legacyT as { id: string }).id);
  check((legacyT as { organization_id: string }).organization_id === MB, "a row inserted without an organisation lands in Move Beyond (transitional default)");

  const { data: orgs } = await db()
    .from("organizations")
    .insert([
      { slug: `e2e-a-${tag}`, name: `E2E Club A ${tag}`, status: "approved" },
      { slug: `e2e-b-${tag}`, name: `E2E Club B ${tag}`, status: "approved" },
    ])
    .select("id, slug");
  const A = (orgs as { id: string; slug: string }[]).find((o) => o.slug.startsWith("e2e-a"))!.id;
  const B = (orgs as { id: string; slug: string }[]).find((o) => o.slug.startsWith("e2e-b"))!.id;
  created.orgs.push(A, B);

  const SECRET_B = `ZQXB${tag}`; // appears only in org B's rows: any response containing it leaked
  try {
    async function tournament(org: string, name: string) {
      const { data: t } = await db()
        .from("tournaments")
        .insert({ name, slug: `e2e-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${tag}`, organization_id: org, status: "active", is_demo: true, public_access_enabled: true })
        .select("id, slug")
        .single();
      const id = (t as { id: string }).id;
      created.tournaments.push(id);
      const { data: teams } = await db()
        .from("teams")
        .insert([
          { tournament_id: id, team_name: `${name} Team One` },
          { tournament_id: id, team_name: `${name} Team Two` },
        ])
        .select("id");
      const [t1, t2] = (teams as { id: string }[]).map((x) => x.id);
      const { data: pl } = await db()
        .from("players")
        .insert({ tournament_id: id, team_id: t1, full_name: `${name} Player`, player_order: 1, phone: "+201011112222" })
        .select("id")
        .single();
      const { data: court } = await db().from("courts").insert({ tournament_id: id, court_name: "Court 1", court_order: 1 }).select("id").single();
      const { data: m } = await db()
        .from("matches")
        .insert({ tournament_id: id, stage: "group", round_name: "Round 1", match_order: 1, team_a_id: t1, team_b_id: t2, court_id: (court as { id: string }).id, status: "scheduled" })
        .select("id")
        .single();
      await db().from("screen_settings").insert({ tournament_id: id, screen_key: "main" });
      return { id, slug: (t as { slug: string }).slug, team1: t1, team2: t2, player: (pl as { id: string }).id, match: (m as { id: string }).id, court: (court as { id: string }).id };
    }
    const TA = await tournament(A, `Alpha Open ${tag}`);
    const TA2 = await tournament(A, `Alpha Second ${tag}`);
    const TB = await tournament(B, `${SECRET_B} Bravo Cup`);
    await db().from("teams").update({ nation_code: "ZQX" }).eq("id", TB.team1);

    // B's tie, group and group placement; A's own group and draft bracket slot (targets for B's ids).
    const { data: tieRow } = await db().from("ties").insert({ tournament_id: TB.id, team_a_id: TB.team1, team_b_id: TB.team2, round_no: 1, tie_order: 1 }).select("id").single();
    const TIE_B = (tieRow as { id: string }).id;
    const { data: gbRow } = await db().from("groups").insert({ tournament_id: TB.id, group_name: "B1", group_order: 1 }).select("id").single();
    const GROUP_B = (gbRow as { id: string }).id;
    const { data: gtbRow } = await db().from("group_teams").insert({ tournament_id: TB.id, group_id: GROUP_B, team_id: TB.team1, position: 1 }).select("id").single();
    const GT_B = (gtbRow as { id: string }).id;
    await db().from("groups").insert({ tournament_id: TA.id, group_name: "A1", group_order: 1 });
    const { data: brA } = await db().from("brackets").insert({ tournament_id: TA.id, tier: "cup", status: "draft" }).select("id").single();
    const { data: slotA } = await db().from("bracket_slots").insert({ bracket_id: (brA as { id: string }).id, tournament_id: TA.id, round_name: "Final", slot_order: 1 }).select("id").single();
    const SLOT_A = (slotA as { id: string }).id;

    const { data: groups } = await db()
      .from("event_groups")
      .insert([{ slug: `e2e-gb-${tag}`, name: `${SECRET_B} Group`, organization_id: B }])
      .select("id, slug");
    const GB = (groups as { id: string; slug: string }[])[0]!;
    created.groups.push(GB.id);
    const { data: seasons } = await db().from("seasons").insert({ name: `${SECRET_B} Season`, organization_id: B, status: "upcoming" }).select("id").single();
    const SeB = (seasons as { id: string }).id;
    created.seasons.push(SeB);
    const { data: ab } = await db()
      .from("message_announcements")
      .insert({ title: `${SECRET_B} Announcement`, body: "secret", channels: ["email"], audience: { type: "tournament", tournamentId: TB.id }, tournament_id: TB.id, organization_id: B, status: "sending" })
      .select("id")
      .single();
    const AB = (ab as { id: string }).id;
    created.announcements.push(AB);
    const { data: anb } = await db().from("announcements").insert({ tournament_id: TB.id, title: `${SECRET_B} App News`, level: "info" }).select("id").single();
    const ANB = (anb as { id: string }).id;
    const { data: pb } = await db().from("player_profiles").insert({ public_name: `${SECRET_B} Profile`, mobile_normalized: `+2010${tag.replace(/\D/g, "0").padEnd(8, "7").slice(0, 8)}`, approval_status: "approved" }).select("id").single();
    const PB = (pb as { id: string }).id;
    created.profiles.push(PB);
    await db().from("organization_players").insert({ organization_id: B, player_profile_id: PB, approval_status: "approved", notes: `${SECRET_B} note` });
    const SB = await createFriendlySession({
      name: `${SECRET_B} Night`,
      seasonId: null,
      startsAt: null,
      durationMinutes: null,
      courtCount: 1,
      pairingMode: "americano",
      rankingModel: "win_points",
      setsToWinMatch: 1,
      gamesToWinSet: 6,
      maxPlayers: null,
      registrationDeadline: null,
      organizationId: B,
      actorRole: "e2e",
    });
    created.sessions.push(SB.id);
    created.tournaments.push(SB.tournament_id);
    const { data: eb } = await db().from("friendly_entries").insert({ session_id: SB.id, player_profile_id: PB, source: "admin", approval: "pending" }).select("id").single();
    const EB = (eb as { id: string }).id;
    const SA = await createFriendlySession({
      name: `Alpha Night ${tag}`,
      seasonId: null,
      startsAt: null,
      durationMinutes: null,
      courtCount: 1,
      pairingMode: "americano",
      rankingModel: "win_points",
      setsToWinMatch: 1,
      gamesToWinSet: 6,
      maxPlayers: null,
      registrationDeadline: null,
      organizationId: A,
      actorRole: "e2e",
    });
    created.sessions.push(SA.id);
    created.tournaments.push(SA.tournament_id);
    const { data: sbRow } = await db().from("friendly_sessions").select("slug").eq("id", SB.id).single();
    const SB_SLUG = (sbRow as { slug: string }).slug;

    // Codes: B's referee code; A's referee code (every event); A's operator code (scoped to TA).
    const codeB = generateEventCode();
    const codeAref = generateEventCode();
    const codeAop = generateEventCode();
    const codeArefT = generateEventCode();
    const codeLock = generateEventCode();
    const { data: codes } = await db()
      .from("organization_codes")
      .insert([
        { organization_id: B, role: "referee", code_hash: hashEventCode(codeB), label: "e2e" },
        { organization_id: A, role: "referee", code_hash: hashEventCode(codeAref), label: "e2e" },
        { organization_id: A, role: "operator", tournament_id: TA.id, code_hash: hashEventCode(codeAop), label: "e2e" },
        { organization_id: A, role: "referee", tournament_id: TA.id, code_hash: hashEventCode(codeArefT), label: "e2e scoped" },
        { organization_id: A, role: "referee", code_hash: hashEventCode(codeLock), label: "e2e lockout" },
      ])
      .select("id, organization_id, role");
    const codeRows = codes as { id: string; organization_id: string; role: string }[];
    const CB = codeRows.find((c) => c.organization_id === B)!.id;
    const CAref = codeRows.find((c) => c.organization_id === A && c.role === "referee")!.id;
    {
      const { error } = await db().from("organization_codes").insert({ organization_id: A, role: "referee", tournament_id: TB.id, code_hash: hashEventCode(generateEventCode()), label: "e2e cross-org" });
      check(Boolean(error), "the database refuses an event code of A scoped to B's tournament (trigger)", error?.message);
    }

    // People: A's admin and manager, B's owner.
    const aAdminUser = await standinUser(`e2e.a.admin.${tag}@example.com`);
    const aManagerUser = await standinUser(`e2e.a.manager.${tag}@example.com`);
    const bOwnerUser = await standinUser(`e2e.b.owner.${tag}@example.com`);
    await db()
      .from("organization_members")
      .insert([
        { organization_id: A, auth_user_id: aAdminUser.id, invited_email: `e2e.a.admin.${tag}@example.com`, role: "admin", status: "active" },
        { organization_id: A, auth_user_id: aManagerUser.id, invited_email: `e2e.a.manager.${tag}@example.com`, role: "manager", status: "active" },
        { organization_id: B, auth_user_id: bOwnerUser.id, invited_email: `e2e.b.owner.${tag}@example.com`, role: "owner", status: "active" },
      ]);
    const { data: aa } = await db()
      .from("message_announcements")
      .insert({ title: `Alpha Announcement ${tag}`, body: "", channels: ["email"], audience: { type: "all_players" }, organization_id: A, status: "sent" })
      .select("id")
      .single();
    created.announcements.push((aa as { id: string }).id);
    ownParams = { tournament: TA.id, session: SA.id, announcement: (aa as { id: string }).id, match: TA.match };

    section("signing in");
    const noOrg = await webGoogleSignIn(`e2e.nobody.${tag}@example.com`);
    check(!noOrg.token && /error=no_org/.test(noOrg.landed), "Google sign-in without a membership gets no staff cookie", noOrg.landed);
    const aAdminWeb = await webGoogleSignIn(`e2e.a.admin.${tag}@example.com`);
    check(Boolean(aAdminWeb.token?.startsWith("mbs1.")) && aAdminWeb.landed.endsWith("/admin/tournaments"), "A's admin signs in with Google on the web and gets an mbs1 staff cookie", aAdminWeb.landed);
    const bOwnerWeb = await webGoogleSignIn(`e2e.b.owner.${tag}@example.com`);
    check(Boolean(bOwnerWeb.token?.startsWith("mbs1.")), "B's owner signs in with Google on the web");
    const tamperedState = await fetch(`${BASE_URL}/staff/auth/callback?code=${randomUUID()}`, { redirect: "manual", headers: { Cookie: "mb_staff_oauth=forged.sig" } });
    check(/error=signin_failed/.test(tamperedState.headers.get("location") ?? "") && !(tamperedState.headers.getSetCookie?.() ?? []).some((c) => c.startsWith("mb_session=mbs1")), "a callback without a valid state cookie signs nobody in");
    const evilNext = await fetch(`${BASE_URL}/staff/auth/google?next=${encodeURIComponent("https://evil.example/x")}`, { redirect: "manual" });
    check(!/evil\.example/.test(decodeURIComponent(evilNext.headers.get("location") ?? "")), "next cannot point off the site");

    const refApp = await http("POST", "/api/mobile/v1/staff/session", {}, { code: formatEventCode(codeAref).toLowerCase() });
    check(refApp.status === 200 && String(refApp.json?.token).startsWith("mbs1.") && refApp.json?.role === "referee", "A's referee signs in in the app with an event code", refApp.json?.role);
    const opApp = await http("POST", "/api/mobile/v1/staff/session", {}, { code: codeAop });
    check(opApp.status === 200 && (opApp.json?.scope as { tournamentId?: string } | null)?.tournamentId === TA.id, "A's scoped operator code carries its tournament scope");
    const bRef = await http("POST", "/api/mobile/v1/staff/session", {}, { code: codeB });
    const wrongCode = await http("POST", "/api/mobile/v1/staff/session", {}, { code: generateEventCode() });
    check(wrongCode.status === 401 && wrongCode.json?.error === "Wrong access code.", "an unknown code is refused", wrongCode.status);
    const hashAsCode = await http("POST", "/api/mobile/v1/staff/session", {}, { code: hashEventCode(codeB) });
    check(hashAsCode.status === 401, "the stored hash does not work as a code");

    const aAdmin: Who = { label: "A admin (Google, cookie)", headers: cookie(aAdminWeb.token ?? "") };
    const aManager: Who = { label: "A manager (cookie)", headers: cookie(staffToken({ kind: "member", userId: aManagerUser.id, orgId: A, role: "manager" })) };
    const aReferee: Who = { label: "A referee (code, bearer)", headers: bearer(String(refApp.json?.token)) };
    const aOperator: Who = { label: "A operator (scoped code, cookie)", headers: cookie(String(opApp.json?.token)) };
    const mbShared: Who = { label: "Move Beyond shared admin", headers: cookie(sessionToken("admin")) };
    const everyone = [aAdmin, aManager, aReferee, aOperator, mbShared];

    // B's name marker, and B's row ids that only B's data would carry.
    const leaked = (text: string) => [SECRET_B, TB.team1, TB.team2, TB.player, TB.match, PB, EB].some((x) => text.includes(x));

    const T = "src/app/admin/tournaments";
    section("own data works (the attack harness is real)");
    {
      const list = await http("GET", "/admin/tournaments", aAdmin.headers);
      check(list.status === 200 && list.text.includes(`Alpha Open ${tag}`) && !leaked(list.text), "A's admin sees A's tournaments and none of B's");
      const own = await http("GET", `/admin/tournaments/${TA.id}/teams`, aManager.headers);
      check(own.status === 200 && own.text.includes(`Alpha Open ${tag} Team One`), "A's manager opens A's teams page");
      const r = await action("src/app/admin/tournaments/[id]/settings/actions.ts", "updateGeneral", [form({ tournament_id: TA.id, name: `Alpha Open ${tag}`, lower_third_text: "ok-own" })], aManager.headers);
      const { data: ta } = await db().from("tournaments").select("lower_third_text").eq("id", TA.id).single();
      check(actionOk(r) && (ta as { lower_third_text: string }).lower_third_text === "ok-own", "a server action called by the harness changes A's own tournament", r.status);
      const typed = await action(`${T}/[id]/bracket/actions.ts`, "listBrackets", [TA.id], aManager.headers);
      check(actionOk(typed), "a typed-argument action works on A's own tournament", typed.status);
      const prevForm = await action("src/app/operator/tournaments/[id]/control/actions.ts", "addScreen", [null, form({ tournament_id: TA.id, screen_name: `Own ${tag}` })], aOperator.headers);
      const { data: ownScreens } = await db().from("screen_settings").select("screen_name").eq("tournament_id", TA.id);
      // (The page the action is posted to may then send an operator to the login: the write is what counts.)
      check(((ownScreens ?? []) as { screen_name: string | null }[]).some((x) => x.screen_name === `Own ${tag}`), "a (state, form) action works for A's scoped operator on its tournament", `${prevForm.status} ${prevForm.text.slice(0, 200)}`);
      const ownMatch = await http("POST", `/api/matches/${TA.match}/claim`, aReferee.headers, { deviceId: `e2e-${tag}`, deviceLabel: "E2E" });
      check(ownMatch.status === 200 && ownMatch.json?.controller === true, "A's referee claims A's match", ownMatch.status);
      await http("POST", `/api/matches/${TA.match}/release-lease`, aReferee.headers, { deviceId: `e2e-${tag}` });
      const bOwn = await http("GET", `/admin/tournaments/${TB.id}`, cookie(bOwnerWeb.token ?? ""));
      check(bOwn.status === 200 && leaked(bOwn.text), "B's owner opens B's own tournament");
      const bRefList = await http("GET", "/api/mobile/v1/referee/tournaments", bearer(String(bRef.json?.token)));
      const bIds = ((bRefList.json?.tournaments ?? []) as { id: string }[]).map((t) => t.id);
      check(bIds.includes(TB.id) && !bIds.includes(TA.id), "B's referee code lists B's tournaments only");
    }

    section("pages: B's rows are a 404 (or the login), with none of B's data");
    const pages = [
      `/admin/tournaments/${TB.id}`,
      `/admin/tournaments/${TB.id}/teams`,
      `/admin/tournaments/${TB.id}/players`,
      `/admin/tournaments/${TB.id}/settings`,
      `/admin/tournaments/${TB.id}/matches`,
      `/admin/tournaments/${TB.id}/app`,
      `/admin/tournaments/${TB.id}/screens`,
      `/admin/tournaments/${TB.id}/match-day`,
      `/admin/announcements/${AB}`,
      `/admin/friendly-sessions/${SB.id}`,
      `/referee/tournaments/${TB.id}/matches`,
      `/referee/friendly-sessions/${SB.id}/matches`,
      `/referee/matches/${TB.match}/score`,
      `/operator/tournaments/${TB.id}/control`,
      `/operator/tournaments/${TB.id}/control/main`,
      `/qr/match/${TB.match}`,
      `/venue/${GB.slug}/qr`,
      `/admin/platform/discover`,
      `/admin/platform/organizations`,
    ];
    for (const who of everyone) {
      for (const p of pages) {
        // The shared admin password is not a platform admin: Discover is refused to it too.
        const r = await http("GET", p, who.headers);
        const refused = r.status === 404 || (r.status >= 300 && r.status < 400 && r.location.includes("/login"));
        // The page echoes its own URL; anything of B's beyond that is a leak.
        const echoed = p.split("/").reduce((t, seg) => (seg.length > 20 ? t.split(seg).join("") : t), r.text);
        check(refused && !leaked(echoed), `${who.label}: ${p} refused`, `${r.status} ${r.location}`);
      }
    }
    section("lists: only the organisation's own rows");
    const lists = ["/admin/tournaments", "/admin/announcements", "/admin/announcements/new", "/admin/friendly-sessions", "/admin/players", "/admin/seasons", "/admin/rankings", "/admin/org/codes", "/admin/org/members", "/admin/org/profile", "/referee", "/operator"];
    for (const who of everyone) {
      for (const p of lists) {
        const r = await http("GET", p, who.headers);
        check(!leaked(r.text), `${who.label}: ${p} shows none of B's rows`, r.status);
      }
    }
    {
      const ref = await http("GET", "/referee", aReferee.headers);
      check(ref.status === 200 && ref.text.includes(`Alpha Open ${tag}`) && ref.text.includes(`Alpha Second ${tag}`), "A's unscoped referee code lists A's tournaments");
      const op = await http("GET", "/operator", aOperator.headers);
      check(op.status === 200 && op.text.includes(`Alpha Open ${tag}`) && !op.text.includes(`Alpha Second ${tag}`), "A's scoped operator code lists only its own tournament");
      const opOther = await http("GET", `/operator/tournaments/${TA2.id}/control`, aOperator.headers);
      check(opOther.status === 404, "…and cannot open A's other tournament", opOther.status);
      const appList = await http("GET", "/api/mobile/v1/referee/tournaments", aReferee.headers);
      const ids = ((appList.json?.tournaments ?? []) as { id: string }[]).map((t) => t.id);
      check(appList.status === 200 && ids.includes(TA.id) && !ids.includes(TB.id) && !leaked(appList.text), "the app's referee list is A's only", ids.length);
      const mb = await http("GET", "/admin/tournaments", mbShared.headers);
      check(mb.status === 200 && !mb.text.includes(`Alpha Open ${tag}`) && !leaked(mb.text), "the shared Move Beyond password sees neither A nor B");
    }

    section("API routes: score, read, export B's rows");
    const deviceId = `e2e-attacker-${tag}`;
    const matchRoutes: [string, string, unknown][] = [
      ["POST", "claim", { deviceId, deviceLabel: "attacker" }],
      ["POST", "renew-lease", { deviceId }],
      ["POST", "release-lease", { deviceId }],
      ["POST", "request-control", { deviceId, deviceLabel: "attacker" }],
      ["POST", "respond-control", { deviceId, accept: true }],
      ["POST", "events", { deviceId, events: [{ client_event_id: randomUUID(), event_number: 1, event_type: "MATCH_STARTED", team_id: null, previous_state: null, new_state: {}, payload: null, created_at_client: new Date().toISOString() }] }],
    ];
    for (const who of everyone) {
      for (const [method, route, body] of matchRoutes) {
        const r = await http(method, `/api/matches/${TB.match}/${route}`, who.headers, body);
        check([401, 403, 404].includes(r.status) && !leaked(r.text), `${who.label}: ${route} on B's match refused`, r.status);
      }
      const boot = await http("GET", `/api/mobile/v1/referee/matches/${TB.match}/bootstrap`, who.headers);
      check([401, 403, 404].includes(boot.status) && !leaked(boot.text), `${who.label}: referee bootstrap of B's match refused`, boot.status);
      const picker = await http("GET", `/api/mobile/v1/referee/tournaments/${TB.id}/matches`, who.headers);
      check([401, 403, 404].includes(picker.status) && !leaked(picker.text), `${who.label}: B's match picker refused`, picker.status);
      for (const p of [`/api/tournaments/${TB.id}/export`, `/api/f/${SB_SLUG}/export`, `/admin/announcements/${AB}/export`]) {
        const r = await http("GET", p, who.headers);
        check([401, 403, 404].includes(r.status) && !leaked(r.text), `${who.label}: export ${p.split("/").slice(0, 3).join("/")}… refused`, r.status);
      }
    }
    {
      const nf = await http("POST", `/api/matches/${randomUUID()}/claim`, aReferee.headers, { deviceId });
      const ny = await http("POST", `/api/matches/${TB.match}/claim`, aReferee.headers, { deviceId });
      check(nf.status === ny.status && nf.text === ny.text, "a missing match and B's match get the identical answer", [nf.status, ny.status]);
      const nfT = await http("GET", `/api/tournaments/${randomUUID()}/export`, aAdmin.headers);
      const nyT = await http("GET", `/api/tournaments/${TB.id}/export`, aAdmin.headers);
      check(nfT.status === nyT.status && nfT.text === nyT.text, "a missing tournament and B's get the identical export answer");
      const { count: evs } = await db().from("score_events").select("id", { count: "exact", head: true }).eq("match_id", TB.match);
      const { count: leases } = await db().from("scoring_leases").select("match_id", { count: "exact", head: true }).eq("match_id", TB.match);
      check(evs === 0 && leases === 0, "B's match has no events and no lease after the attacks", { evs, leases });
    }

    section("server actions with B's ids");
    const attacks: { label: string; file: string; name: string; args: () => unknown[] }[] = [
      { label: "rename B's tournament", file: `${T}/[id]/settings/actions.ts`, name: "updateGeneral", args: () => [form({ tournament_id: TB.id, name: "PWNED", lower_third_text: "PWNED" })] },
      { label: "archive B's tournament", file: `${T}/actions.ts`, name: "setTournamentStatus", args: () => [form({ id: TB.id, status: "archived" })] },
      { label: "delete B's tournament", file: `${T}/actions.ts`, name: "deleteTournament", args: () => [form({ id: TB.id })] },
      { label: "reset B's tournament", file: `${T}/actions.ts`, name: "resetTournamentData", args: () => [form({ id: TB.id })] },
      { label: "clone B's tournament", file: `${T}/actions.ts`, name: "cloneTournamentAction", args: () => [form({ source_id: TB.id, name: `PWNED clone ${tag}`, copy_teams: "on" })] },
      { label: "add a team to B's tournament", file: `${T}/[id]/teams/actions.ts`, name: "addTeam", args: () => [form({ tournament_id: TB.id, team_name: "PWNED team", player_1_name: "x", player_2_name: "y" })] },
      { label: "rename B's team through A's tournament id", file: `${T}/[id]/teams/actions.ts`, name: "updateTeam", args: () => [form({ tournament_id: TA.id, team_id: TB.team1, team_name: "PWNED" })] },
      { label: "delete B's team", file: `${T}/[id]/teams/actions.ts`, name: "deleteTeam", args: () => [form({ tournament_id: TB.id, team_id: TB.team1 })] },
      { label: "delete B's match", file: `${T}/[id]/matches/actions.ts`, name: "deleteMatch", args: () => [form({ tournament_id: TB.id, match_id: TB.match })] },
      { label: "release B's scoring lock", file: `${T}/[id]/matches/actions.ts`, name: "releaseScoringLock", args: () => [form({ tournament_id: TB.id, match_id: TB.match })] },
      { label: "change B's player's phone", file: `${T}/[id]/players/actions.ts`, name: "savePlayerContact", args: () => [form({ tournament_id: TB.id, player_id: TB.player, phone: "+201099999999", email: "pwned@example.com" })] },
      { label: "send B's player their code", file: `${T}/[id]/players/actions.ts`, name: "sendCode", args: () => [null, form({ tournament_id: TB.id, player_id: TB.player, channel: "email" })] },
      { label: "join A's tournament to B's event group", file: `${T}/[id]/app/actions.ts`, name: "saveAppSettings", args: () => [form({ tournament_id: TA.id, event_group_id: GB.id, timezone: "Africa/Cairo" })] },
      { label: "edit B's event group", file: `${T}/[id]/app/actions.ts`, name: "saveEventGroup", args: () => [form({ tournament_id: TA.id, group_id: GB.id, name: "PWNED" })] },
      { label: "delete B's app announcement", file: `${T}/[id]/app/actions.ts`, name: "deleteAnnouncement", args: () => [form({ tournament_id: TA.id, announcement_id: ANB })] },
      { label: "post to B's app", file: `${T}/[id]/app/actions.ts`, name: "postAnnouncement", args: () => [form({ tournament_id: TB.id, title: "PWNED", level: "major" })] },
      { label: "change B's match-day rules", file: `${T}/[id]/match-day/actions.ts`, name: "saveMatchDayRules", args: () => [form({ tournament_id: TB.id })] },
      { label: "read B's draw options", file: `${T}/[id]/groups/actions.ts`, name: "drawOptions", args: () => [TB.id, 2] },
      { label: "read B's brackets", file: `${T}/[id]/bracket/actions.ts`, name: "listBrackets", args: () => [TB.id] },
      { label: "read B's replay progress", file: `${T}/[id]/replay/actions.ts`, name: "replayProgressAction", args: () => [TB.id, [TB.match]] },
      { label: "open B's session", file: "src/app/admin/friendly-sessions/actions.ts", name: "setStatusAction", args: () => [form({ session_id: SB.id, status: "open" })] },
      { label: "approve B's registration", file: "src/app/admin/friendly-sessions/actions.ts", name: "approveEntryAction", args: () => [form({ entry_id: EB, session_id: SA.id })] },
      { label: "add B's player to A's session", file: "src/app/admin/friendly-sessions/actions.ts", name: "addPlayerAction", args: () => [form({ session_id: SA.id, player_profile_id: PB })] },
      { label: "add B's player to A's session (typed)", file: "src/app/admin/friendly-sessions/actions.ts", name: "addPlayersAction", args: () => [SA.id, [PB], false] },
      { label: "rename B's season", file: "src/app/admin/seasons/actions.ts", name: "updateSeason", args: () => [form({ season_id: SeB, name: "PWNED" })] },
      { label: "activate B's season", file: "src/app/admin/seasons/actions.ts", name: "setSeasonStatus", args: () => [form({ season_id: SeB, status: "active" })] },
      { label: "delete B's season", file: "src/app/admin/seasons/actions.ts", name: "deleteSeason", args: () => [form({ season_id: SeB })] },
      { label: "rename B's player", file: "src/app/admin/players/actions.ts", name: "updatePlayerProfile", args: () => [form({ profile_id: PB, public_name: "PWNED" })] },
      { label: "reject B's player", file: "src/app/admin/players/actions.ts", name: "setPlayerApproval", args: () => [form({ profile_id: PB, approval_status: "rejected" })] },
      { label: "cancel B's announcement", file: "src/app/admin/announcements/actions.ts", name: "cancelAction", args: () => [form({ id: AB })] },
      { label: "retry B's announcement", file: "src/app/admin/announcements/actions.ts", name: "retryFailedAction", args: () => [form({ id: AB })] },
      { label: "pump B's announcement", file: "src/app/admin/announcements/actions.ts", name: "pumpAction", args: () => [AB] },
      {
        label: "preview a message to B's tournament",
        file: "src/app/admin/announcements/actions.ts",
        name: "previewAction",
        args: () => [{ kind: "announcement", title: "x", body: "x", channels: ["email"], audience: { type: "tournament", tournamentId: TB.id }, tournamentId: null }],
      },
      {
        label: "message B's tournament",
        file: "src/app/admin/announcements/actions.ts",
        name: "createAndSendAction",
        args: () => [{ kind: "announcement", title: `PWNED ${tag}`, body: "x", channels: ["email"], audience: { type: "tournament", tournamentId: TB.id }, tournamentId: null }],
      },
      { label: "add a screen to B's tournament", file: "src/app/operator/tournaments/[id]/control/actions.ts", name: "addScreen", args: () => [null, form({ tournament_id: TB.id, screen_name: "PWNED" })] },
      { label: "mute B's screen", file: "src/app/operator/tournaments/[id]/control/actions.ts", name: "screenCommand", args: () => [null, form({ tournament_id: TB.id, screen_key: "main", revision: "0", command: "mute_on" })] },
      { label: "read B's screen", file: "src/app/operator/tournaments/[id]/control/actions.ts", name: "currentScreen", args: () => [TB.id, "main"] },
      { label: "revoke B's event code", file: "src/app/admin/org/codes/actions.ts", name: "revokeEventCode", args: () => [form({ code_id: CB })] },
      { label: "make a code for B's tournament", file: "src/app/admin/org/codes/actions.ts", name: "createEventCode", args: () => [null, form({ role: "referee", tournament_id: TB.id })] },
      // B's rows named alongside A's own tournament id (the posted tournament proves nothing about them).
      { label: "set a line-up on B's tie through A's tournament id", file: `${T}/[id]/ties/actions.ts`, name: "saveLineupAction", args: () => [null, form({ tournament_id: TA.id, tie_id: TIE_B, side: "A", S1: TB.player, S2: TB.player, D1: TB.player, D2: TB.player })] },
      { label: "lock B's tie line-ups through A's tournament id", file: `${T}/[id]/ties/actions.ts`, name: "lockLineupsAction", args: () => [null, form({ tournament_id: TA.id, tie_id: TIE_B })] },
      { label: "reschedule B's tie through A's tournament id", file: `${T}/[id]/ties/actions.ts`, name: "scheduleTieAction", args: () => [null, form({ tournament_id: TA.id, tie_id: TIE_B, court_id: "", scheduled_local: "2026-11-04T10:00" })] },
      { label: "reschedule B's tie onto A's court", file: `${T}/[id]/ties/actions.ts`, name: "scheduleTieAction", args: () => [null, form({ tournament_id: TA.id, tie_id: TIE_B, court_id: TA.court, scheduled_local: "" })] },
      { label: "place B's team in A's bracket slot", file: `${T}/[id]/bracket/actions.ts`, name: "saveSlots", args: () => [form({ tournament_id: TA.id, tier: "cup", [`slot_${SLOT_A}`]: TB.team1 })] },
      { label: "draw B's teams into A's groups", file: `${T}/[id]/groups/actions.ts`, name: "saveAssignment", args: () => [TA.id, [[TB.team1, TB.team2]]] },
      { label: "lock B's group placement through A's tournament id", file: `${T}/[id]/groups/actions.ts`, name: "toggleLock", args: () => [form({ tournament_id: TA.id, group_team_id: GT_B })] },
      { label: "rename B's nation through A's tournament id", file: `${T}/[id]/nations/actions.ts`, name: "updateNation", args: () => [form({ tournament_id: TA.id, team_id: TB.team1, team_name: "PWNED", nation_code: "PWN" })] },
      { label: "delete B's nation through A's tournament id", file: `${T}/[id]/nations/actions.ts`, name: "deleteNation", args: () => [form({ tournament_id: TA.id, team_id: TB.team1 })] },
      { label: "override B's qualification through A's tournament id", file: `${T}/[id]/leaderboard/actions.ts`, name: "overrideQualification", args: () => [null, form({ tournament_id: TA.id, team_id: TB.team1, group_id: GROUP_B, status: "qualified" })] },
      { label: "put A's match on B's court", file: `${T}/[id]/matches/actions.ts`, name: "updateMatchSchedule", args: () => [form({ tournament_id: TA.id, match_id: TA.match, court_id: TB.court, match_order: "1", scheduled_time: "" })] },
      { label: "reschedule B's match through A's tournament id", file: `${T}/[id]/matches/actions.ts`, name: "updateMatchSchedule", args: () => [form({ tournament_id: TA.id, match_id: TB.match, court_id: "", match_order: "9", scheduled_time: "" })] },
      { label: "a manual match of B's teams in A's tournament", file: `${T}/[id]/matches/actions.ts`, name: "createManualMatch", args: () => [form({ tournament_id: TA.id, team_a_id: TB.team1, team_b_id: TB.team2, round_name: "PWNED" })] },
      { label: "a manual match of A's teams on B's court", file: `${T}/[id]/matches/actions.ts`, name: "createManualMatch", args: () => [form({ tournament_id: TA.id, team_a_id: TA.team1, team_b_id: TA.team2, court_id: TB.court, round_name: "PWNED" })] },
      { label: "check B's team in through A's tournament id", file: `${T}/[id]/teams/actions.ts`, name: "setCheckIn", args: () => [form({ tournament_id: TA.id, team_id: TB.team1, status: "no_show" })] },
      { label: "release B's scoring lock through A's tournament id", file: `${T}/[id]/matches/actions.ts`, name: "releaseScoringLock", args: () => [form({ tournament_id: TA.id, match_id: TB.match })] },
      { label: "change B's match-day rules through A's own page", file: `${T}/[id]/match-day/actions.ts`, name: "saveMatchDayRules", args: () => [form({ tournament_id: TB.id, rules: "PWNED" })] },
      { label: "merge B's player into one of A's", file: "src/app/admin/players/actions.ts", name: "mergePlayersAction", args: () => [form({ survivor_id: PB, absorbed_id: PB })] },
      { label: "record consent for B's player", file: "src/app/admin/players/actions.ts", name: "setPlayerConsent", args: () => [form({ profile_id: PB, channel: "whatsapp", granted: "1" })] },
      { label: "offer to link B's player to an app account", file: "src/app/admin/players/actions.ts", name: "offerAppLinkAction", args: () => [form({ profile_id: PB, account_email: `pwned-${tag}@example.com` })] },
      { label: "withdraw B's link offers", file: "src/app/admin/players/actions.ts", name: "withdrawAppLinkAction", args: () => [form({ profile_id: PB })] },
      // Move Beyond's platform settings: platform admins only, never the shared admin password.
      { label: "change the app's feature flags", file: "src/app/admin/platform/discover/actions.ts", name: "saveFlags", args: () => [form({ new_flag: `pwned_${tag}`, new_flag_on: "on" })] },
      { label: "reorder Discover", file: "src/app/admin/platform/discover/actions.ts", name: "saveDiscoverOrder", args: () => [form({ item: TB.id, [`pos.${TB.id}`]: "0" })] },
    ];
    async function bSnapshot() {
      const [tie, gt, slot, aMatch, crossMatches, stand, consentsB, platform, checkIn] = await Promise.all([
        db().from("ties").select("lineup_locked_at, court_id, scheduled_time, team_a_id, team_b_id").eq("id", TIE_B).maybeSingle(),
        db().from("group_teams").select("is_locked, group_id, team_id").eq("id", GT_B).maybeSingle(),
        db().from("bracket_slots").select("team_id, is_bye").eq("id", SLOT_A).maybeSingle(),
        db().from("matches").select("court_id, match_order").eq("id", TA.match).maybeSingle(),
        db().from("matches").select("id").eq("tournament_id", TA.id).or(`team_a_id.eq.${TB.team1},team_b_id.eq.${TB.team2},court_id.eq.${TB.court}`),
        db().from("group_teams").select("id").eq("tournament_id", TA.id),
        db().from("player_consents").select("channel, granted").eq("player_profile_id", PB),
        db().from("platform_settings").select("key, value_json").order("key"),
        db().from("teams").select("check_in_status, nation_code").eq("id", TB.team1).maybeSingle(),
      ]);
      const extra = [tie.data, gt.data, slot.data, aMatch.data, crossMatches.data, stand.data, consentsB.data, platform.data, checkIn.data];
      const [t, team, pl, m, g, se, a, an, prof, op, s, e, sc, cd, codesForTB, newAnn, clones, appPosts, screens, deliveries, offersB] = await Promise.all([
        db().from("tournaments").select("name, status, lower_third_text, match_day_rules").eq("id", TB.id).maybeSingle(),
        db().from("teams").select("id, team_name").eq("tournament_id", TB.id).order("id"),
        db().from("players").select("phone, email").eq("id", TB.player).maybeSingle(),
        db().from("matches").select("id, status").eq("id", TB.match).maybeSingle(),
        db().from("event_groups").select("name").eq("id", GB.id).maybeSingle(),
        db().from("seasons").select("name, status").eq("id", SeB).maybeSingle(),
        db().from("message_announcements").select("status").eq("id", AB).maybeSingle(),
        db().from("announcements").select("id").eq("id", ANB).maybeSingle(),
        db().from("player_profiles").select("public_name, approval_status").eq("id", PB).maybeSingle(),
        db().from("organization_players").select("approval_status, notes").eq("organization_id", B).eq("player_profile_id", PB).maybeSingle(),
        db().from("friendly_sessions").select("status").eq("id", SB.id).maybeSingle(),
        db().from("friendly_entries").select("approval").eq("id", EB).maybeSingle(),
        db().from("friendly_entries").select("id").eq("session_id", SA.id).eq("player_profile_id", PB),
        db().from("organization_codes").select("revoked_at").eq("id", CB).maybeSingle(),
        db().from("organization_codes").select("id").eq("tournament_id", TB.id),
        db().from("message_announcements").select("id").eq("title", `PWNED ${tag}`),
        db().from("tournaments").select("id").eq("name", `PWNED clone ${tag}`),
        db().from("announcements").select("id").eq("tournament_id", TB.id),
        db().from("screen_settings").select("screen_key, screen_name, revision, mute_animations").eq("tournament_id", TB.id).order("screen_key"),
        db().from("message_deliveries").select("id").eq("recipient_id", TB.player),
        db().from("player_link_offers").select("id, revoked_at").eq("player_profile_id", PB),
      ]);
      const { data: ta } = await db().from("tournaments").select("event_group_id").eq("id", TA.id).maybeSingle();
      return JSON.stringify([t.data, team.data, pl.data, m.data, g.data, se.data, a.data, an.data, prof.data, op.data, s.data, e.data, sc.data, cd.data, codesForTB.data, newAnn.data, clones.data, appPosts.data, screens.data, deliveries.data, offersB.data, ta, extra]);
    }
    const before = await bSnapshot();
    for (const who of everyone) {
      for (const atk of attacks) {
        const r = await action(atk.file, atk.name, atk.args(), who.headers);
        check(actionRefused(r) && !leaked(r.text), `${who.label}: ${atk.label} refused`, `${r.status} ${r.text.slice(0, 120)}`);
      }
    }
    const after = await bSnapshot();
    check(before === after, "none of B's rows changed (tournament, teams, player, match, group, season, announcements, profile, session, entries, codes, screens, deliveries, link offers, tie, group placement, consents) and A's rows took none of B's (bracket slot, groups, matches, courts); platform settings unchanged", before === after ? undefined : { before, after });
    {
      // A missing tie and B's tie get the same words.
      const nf = await action(`${T}/[id]/ties/actions.ts`, "lockLineupsAction", [null, form({ tournament_id: TA.id, tie_id: randomUUID() })], aAdmin.headers);
      const ny = await action(`${T}/[id]/ties/actions.ts`, "lockLineupsAction", [null, form({ tournament_id: TA.id, tie_id: TIE_B })], aAdmin.headers);
      const words = (t: string) => /"message":"([^"]*)"/.exec(t)?.[1] ?? t.slice(0, 80);
      check(actionRefused(nf) && words(nf.text) === words(ny.text), "a missing tie and B's tie get the identical answer", [words(nf.text), words(ny.text)]);
    }
    {
      const nfr = await action(`${T}/[id]/settings/actions.ts`, "updateGeneral", [form({ tournament_id: randomUUID(), name: "x" })], aAdmin.headers);
      const nyr = await action(`${T}/[id]/settings/actions.ts`, "updateGeneral", [form({ tournament_id: TB.id, name: "x" })], aAdmin.headers);
      check(nfr.status === nyr.status, "a missing tournament and B's get the same action answer", [nfr.status, nyr.status]);
    }
    {
      // A message to "a nation" resolves inside A only: B's nation code reaches nobody.
      const r = await action("src/app/admin/announcements/actions.ts", "previewAction", [{ kind: "announcement", title: "x", body: "x", channels: ["email"], audience: { type: "nation", nationCode: "ZQX" }, tournamentId: null }], aAdmin.headers);
      check(actionOk(r) && /"people":0/.test(r.text) && !leaked(r.text), "a nation audience reaches only A's own teams (B's nation: nobody)", r.text.slice(0, 160));
      const all = await action("src/app/admin/announcements/actions.ts", "previewAction", [{ kind: "announcement", title: "x", body: "x", channels: ["email"], audience: { type: "all_players" }, tournamentId: null }], aAdmin.headers);
      check(actionOk(all) && !leaked(all.text), "\"all players\" for A has none of B's players", all.text.slice(0, 120));
      const app = await action("src/app/admin/announcements/actions.ts", "previewAction", [{ kind: "announcement", title: "x", body: "x", channels: ["push"], audience: { type: "app_users" }, tournamentId: null }], aAdmin.headers);
      check(/"ok":false/.test(app.text) || !actionOk(app), "a push to every app user is Move Beyond's, not A's", app.text.slice(0, 160));
    }

    section("public registration: B's player pulled into A by a typed mobile");
    {
      const digits = () => String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
      const M2 = `+2011${digits()}`;
      const M3 = `+2012${digits()}`;
      const EMAIL2 = `pulled.${tag}@example.com`;
      const PHOTO2 = `https://example.com/pulled-${tag}.jpg`;
      const { data: pb2 } = await db()
        .from("player_profiles")
        .insert({ public_name: `Pulled ${tag}`, mobile_normalized: M2, email: EMAIL2, birth_year: 1977, gender: "female", approval_status: "approved" })
        .select("id")
        .single();
      const PB2 = (pb2 as { id: string }).id;
      created.profiles.push(PB2);
      await db().from("organization_players").insert({ organization_id: B, player_profile_id: PB2, approval_status: "approved", source: "admin" });
      await db().from("friendly_sessions").update({ status: "open", registration_mode: "either" }).eq("id", SA.id);
      const { data: saRow } = await db().from("friendly_sessions").select("slug").eq("id", SA.id).single();
      const SA_SLUG = (saRow as { slug: string }).slug;
      const mediaPrefix = `${SUPA}/storage/v1/object/public/media/pending/`;
      const register = (body: Record<string, unknown>, ip: string, extra: Record<string, string> = {}) =>
        http("POST", `/api/f/${SA_SLUG}/register`, { "X-Forwarded-For": ip, ...extra }, body);

      // The attack: A's form, B's player's number (sent with A's admin cookie in the same browser).
      const r1 = await register({ public_name: "Anyone At All", mobile: M2, consent_whatsapp: true, photo_url: `${mediaPrefix}e2e-${tag}.jpg`, focal_x: 0.5, focal_y: 0.5 }, "198.51.100.10", aAdmin.headers);
      check(r1.status === 200 && r1.json?.ok === true, "the form answers the same opaque OK (the registering person's own flow)", r1.status);
      // A real new player through the same form: the positive control.
      const r2 = await register({ public_name: `Fresh ${tag}`, mobile: M3, consent_whatsapp: true }, "198.51.100.11");
      check(r2.status === 200 && r2.json?.ok === true, "a new player registers through A's form", r2.status);
      const { data: pb3 } = await db().from("player_profiles").select("id").eq("mobile_normalized", M3).maybeSingle();
      const PB3 = (pb3 as { id: string } | null)?.id ?? "";
      if (PB3) created.profiles.push(PB3);

      const { data: rows } = await db().from("organization_players").select("player_profile_id, source").eq("organization_id", A).in("player_profile_id", [PB2, PB3]);
      const src = new Map(((rows ?? []) as { player_profile_id: string; source: string }[]).map((r) => [r.player_profile_id, r.source]));
      check(src.get(PB2) === "matched" && src.get(PB3) === "registration", "A records B's player as 'matched' and its own new player as 'registration'", Object.fromEntries(src));
      const { data: after2 } = await db().from("player_profiles").select("public_name, photo_url, mobile_normalized, email").eq("id", PB2).single();
      const { data: consent2 } = await db().from("player_consents").select("channel").eq("player_profile_id", PB2);
      const { data: consent3 } = await db().from("player_consents").select("channel, granted").eq("player_profile_id", PB3);
      check(
        (after2 as { photo_url: string | null }).photo_url === null && (consent2 ?? []).length === 0,
        "A's form writes no photo and no WhatsApp consent onto B's player",
        { after2, consent2 },
      );
      check(((consent3 ?? []) as { granted: boolean }[]).some((c) => c.granted), "…but does for the player it created", consent3);

      const secrets = [M2, M2.slice(1), EMAIL2, PHOTO2, `${new Date().getUTCFullYear() - 1977} yrs`];
      const shows = (t: string) => secrets.filter((x) => t.includes(x));
      await db().from("player_profiles").update({ photo_url: PHOTO2 }).eq("id", PB2); // B's own photo, set by B
      const listA = await http("GET", "/admin/players", aAdmin.headers);
      check(listA.status === 200 && listA.text.includes("Anyone At All") && listA.text.includes("person-hidden") && shows(listA.text).length === 0, "A's players page lists the entry but none of B's player's mobile, email, birth year or photo", shows(listA.text));
      check(!listA.text.includes(`Pulled ${tag}`), "…and shows the name typed on A's form, never the profile's own name (a mobile number does not turn into a name)");
      check(listA.text.includes(M3), "…while A sees its own new player's mobile");
      const searchA = await http("GET", `/admin/players?q=${encodeURIComponent(`Pulled ${tag}`)}`, aAdmin.headers);
      check(searchA.status === 200 && !searchA.text.includes("Anyone At All") && !searchA.text.includes(PB2), "…and searching A's players for the real name finds nothing (no guessing oracle)");
      const sessionA = await http("GET", `/admin/friendly-sessions/${SA.id}`, aAdmin.headers);
      check(sessionA.status === 200 && sessionA.text.includes("Anyone At All") && !sessionA.text.includes(`Pulled ${tag}`) && shows(sessionA.text).length === 0, "A's session page shows the entry under the typed name, not B's player's name or contact fields", shows(sessionA.text));
      const listB = await http("GET", "/admin/players", cookie(bOwnerWeb.token ?? ""));
      check(listB.text.includes(M2) && listB.text.includes(EMAIL2) && listB.text.includes(`Pulled ${tag}`), "B still sees its own player's name and contact fields");
      const { data: typedRow } = await db().from("organization_players").select("typed_name").eq("organization_id", A).eq("player_profile_id", PB2).single();
      check((typedRow as { typed_name: string | null }).typed_name === "Anyone At All", "the typed name is kept on A's own row", typedRow);
      const exportA = await http("GET", `/api/f/${SA_SLUG}/export`, aAdmin.headers);
      check(exportA.status === 200 && shows(exportA.text).length === 0, "A's session export has none of them", exportA.status);

      const preview = await action("src/app/admin/announcements/actions.ts", "previewAction", [{ kind: "announcement", title: "x", body: "x", channels: ["email", "whatsapp"], audience: { type: "all_players" }, tournamentId: null }], aAdmin.headers);
      check(/"people":1\b/.test(preview.text) && !preview.text.includes(`Pulled ${tag}`) && shows(preview.text).length === 0, "\"all players\" for A reaches its own new player only, not B's", preview.text.slice(0, 200));

      const consent = await action("src/app/admin/players/actions.ts", "setPlayerConsent", [form({ profile_id: PB2, channel: "email", granted: "1" })], aAdmin.headers);
      const { data: consent2b } = await db().from("player_consents").select("channel").eq("player_profile_id", PB2);
      check(actionRefused(consent) && (consent2b ?? []).length === 0, "A cannot record consent for B's player", consent.text.slice(0, 120));
      const edit = await action("src/app/admin/players/actions.ts", "updatePlayerProfile", [form({ profile_id: PB2, public_name: "PWNED", mobile: "+201099990000", email: "pwned@example.com", birth_year: "1999", notes: "A's own note" })], aAdmin.headers);
      const { data: after2b } = await db().from("player_profiles").select("public_name, mobile_normalized, email, birth_year").eq("id", PB2).single();
      const { data: noteA } = await db().from("organization_players").select("notes").eq("organization_id", A).eq("player_profile_id", PB2).single();
      check(
        actionOk(edit) && JSON.stringify(after2b) === JSON.stringify({ public_name: `Pulled ${tag}`, mobile_normalized: M2, email: EMAIL2, birth_year: 1977 }) && (noteA as { notes: string }).notes === "A's own note",
        "A edits only its own part (notes), never B's player's person fields",
        after2b,
      );
      const merge = await action("src/app/admin/players/actions.ts", "mergePlayersAction", [form({ survivor_id: PB3, absorbed_id: PB2 })], aAdmin.headers);
      const { data: still } = await db().from("player_profiles").select("merged_into_profile_id").eq("id", PB2).single();
      check(actionRefused(merge) && !(still as { merged_into_profile_id: string | null }).merged_into_profile_id, "A cannot merge B's player into its own (platform admins only)");
      const taken = await action("src/app/admin/players/actions.ts", "createPlayerProfile", [form({ public_name: "Probe", mobile: M2 })], aAdmin.headers);
      const takenOwn = await action("src/app/admin/players/actions.ts", "createPlayerProfile", [form({ public_name: "Probe", mobile: M3 })], aAdmin.headers);
      check(actionRefused(taken) && actionRefused(takenOwn) && taken.status === takenOwn.status && !taken.text.includes(`Pulled ${tag}`), "a taken mobile gets one answer, whoever's player it is");

      const { data: entry } = await db().from("friendly_entries").select("id, approval").eq("session_id", SA.id).eq("player_profile_id", PB2).single();
      const approve = await action("src/app/admin/friendly-sessions/actions.ts", "approveEntryAction", [form({ entry_id: (entry as { id: string }).id, session_id: SA.id })], aAdmin.headers);
      const { data: entry2 } = await db().from("friendly_entries").select("approval").eq("id", (entry as { id: string }).id).single();
      check(actionOk(approve) && (entry2 as { approval: string }).approval === "approved", "A can still approve the registration (the registering person's flow works)", entry2);

      const { data: regAudit } = await db().from("audit_logs").select("organization_id, actor_role, actor_user_id, new_value").eq("action", "FRIENDLY_REGISTRATION_SUBMITTED").eq("entity_id", SA.id);
      const regRows = (regAudit ?? []) as { organization_id: string | null; actor_role: string | null; actor_user_id: string | null }[];
      check(regRows.length >= 2 && regRows.every((r) => r.actor_role === "public" && r.actor_user_id === null && r.organization_id === A), "public registrations are audited as public, never as the staff cookie in the same browser", regRows);

      section("a matched player's person fields reach nothing A can see (H1, M1)");
      {
        // A's own rows linked to B's player: a team player in A's tournament (how a link joins
        // A's row to someone else's profile) and A's session draw, with B's photo on the profile.
        const PHOTO2P = `https://example.com/pulled-portrait-${tag}.png`;
        await db().from("player_profiles").update({ photo_url: PHOTO2, portrait_url: PHOTO2P }).eq("id", PB2);
        const { data: linkedRow } = await db().from("players").insert({ tournament_id: TA.id, team_id: TA.team2, full_name: "Anyone At All", player_order: 2, player_profile_id: PB2 }).select("id").single();
        const LINKED = (linkedRow as { id: string }).id;
        await db().from("tournaments").update({ app_skin: { showPhotos: true }, match_day_rules: { configured: true, showcase: { on: true, eventDaysOnly: false } } }).eq("id", TA.id);
        await db().from("matches").update({ status: "live", started_at: new Date().toISOString() }).eq("id", TA.match);
        // The session draw: B's player (approved above), A's own new player and two more of A's.
        const extra: string[] = [];
        for (let i = 0; i < 2; i++) {
          const { data: px } = await db().from("player_profiles").insert({ public_name: `Alpha Extra ${i} ${tag}`, approval_status: "approved" }).select("id").single();
          const id = (px as { id: string }).id;
          created.profiles.push(id);
          extra.push(id);
          await db().from("organization_players").insert({ organization_id: A, player_profile_id: id, approval_status: "approved", source: "admin" });
        }
        for (const id of [PB3, ...extra]) if (id) await addEntryForProfile(SA.id, id, "e2e");
        let drawn = 0;
        try {
          drawn = (await generateSchedule(SA.id, "e2e", { fit: "all" })).matchesCreated;
        } catch (err) {
          console.log("   (schedule)", (err as Error).message);
        }
        check(drawn > 0, "A's session draws matches with B's player in them", drawn);
        await db().from("friendly_ranking_snapshots").insert([
          { scope: "session", scope_id: SA.id, player_profile_id: PB2, rank: 1, points: 9, matches_played: 1 },
          { scope: "lifetime", scope_id: A, player_profile_id: PB2, rank: 1, points: 9, matches_played: 1 },
        ]);
        const { data: saT } = await db().from("tournaments").select("slug").eq("id", SA.tournament_id).single();
        const SA_T_SLUG = (saT as { slug: string }).slug;
        const real = [...secrets, PHOTO2P, `Pulled ${tag}`];
        const exposes = (t: string) => real.filter((x) => t.includes(x));
        const surfaces: [string, string, Record<string, string>][] = [
          ["public tournament page", `/t/${TA.slug}`, {}],
          ["public matches page", `/t/${TA.slug}/matches`, {}],
          ["public live page", `/t/${TA.slug}/live`, {}],
          ["TV screen", `/t/${TA.slug}/screen`, {}],
          ["session's TV screen", `/t/${SA_T_SLUG}/screen`, {}],
          ["public session page", `/f/${SA_SLUG}`, {}],
          ["public session rankings", `/f/${SA_SLUG}/rankings`, {}],
          ["public rankings", `/rankings?org=e2e-a-${tag}`, {}],
          ["app tournament bundle", `/api/mobile/v1/t/${TA.slug}/bundle`, {}],
          ["live courts hero", `/api/mobile/v1/courts/live?demo=1`, {}],
          ["referee bootstrap", `/api/mobile/v1/referee/matches/${TA.match}/bootstrap`, aReferee.headers],
          ["referee match picker", `/api/mobile/v1/referee/tournaments/${TA.id}/matches`, aReferee.headers],
          ["admin tournament page", `/admin/tournaments/${TA.id}`, aAdmin.headers],
          ["admin teams page", `/admin/tournaments/${TA.id}/teams`, aAdmin.headers],
          ["admin player codes page", `/admin/tournaments/${TA.id}/players`, aAdmin.headers],
          ["admin players page", `/admin/players`, aAdmin.headers],
          ["admin session page", `/admin/friendly-sessions/${SA.id}`, aAdmin.headers],
          ["admin rankings", `/admin/rankings`, aAdmin.headers],
          ["tournament export", `/api/tournaments/${TA.id}/export`, aAdmin.headers],
          ["session export", `/api/f/${SA_SLUG}/export`, aAdmin.headers],
        ];
        const heroSeen = { ok: false };
        for (const [label, path, who] of surfaces) {
          const r = await http("GET", path, who);
          if (label === "live courts hero") heroSeen.ok = r.text.includes(TA.id) && r.text.includes("Anyone At All");
          check(r.status < 500 && exposes(r.text).length === 0, `${label}: none of B's player's real name, photo, email or mobile`, `${r.status} ${JSON.stringify(exposes(r.text))}`);
        }
        check(heroSeen.ok, "…(the courts hero did carry A's live match with the linked player: the check above is real)");
        const boot = await http("GET", `/api/mobile/v1/referee/matches/${TA.match}/bootstrap`, aReferee.headers);
        check(boot.status === 200 && boot.text.includes("Anyone At All"), "…(the referee bootstrap did carry the linked player under A's typed name)", boot.status);

        for (const audience of [{ type: "tournament", tournamentId: TA.id }, { type: "tournament", tournamentId: SA.tournament_id }]) {
          const pv = await action("src/app/admin/announcements/actions.ts", "previewAction", [{ kind: "announcement", title: "x", body: "x", channels: ["email", "whatsapp"], audience, tournamentId: null }], aAdmin.headers);
          check(actionOk(pv) && exposes(pv.text).length === 0 && !/"emailFrom":"profile"/.test(pv.text), `announcement preview (${audience.tournamentId === TA.id ? "A's tournament" : "A's session"}): no contact or name of B's player, nothing taken from their profile`, exposes(pv.text));
        }
        const sent = await action("src/app/admin/announcements/actions.ts", "createAndSendAction", [{ kind: "announcement", title: `Hello ${tag}`, body: "Hi {name}", channels: ["email"], audience: { type: "tournament", tournamentId: TA.id }, tournamentId: null }], aAdmin.headers);
        const annId = /"id":"([0-9a-f-]{36})"/.exec(sent.text)?.[1] ?? "";
        if (annId) created.announcements.push(annId);
        check(Boolean(annId), "A sends an announcement to its tournament", sent.text.slice(0, 200));
        if (annId) await action("src/app/admin/announcements/actions.ts", "pumpAction", [annId], aAdmin.headers);
        const { data: dels } = await db().from("message_deliveries").select("recipient_id, recipient_name, address, vars").eq("announcement_id", annId);
        check(exposes(JSON.stringify(dels ?? [])).length === 0 && !((dels ?? []) as { recipient_id: string; address: string | null }[]).some((d) => d.recipient_id === LINKED && d.address), "its deliveries hold no address or name of B's player (no profile fallback)", exposes(JSON.stringify(dels ?? [])));
        const detail = await http("GET", `/admin/announcements/${annId}?full=1`, aAdmin.headers);
        const csv = await http("GET", `/admin/announcements/${annId}/export`, aAdmin.headers);
        check(detail.status === 200 && exposes(detail.text).length === 0, "the deliveries page with full numbers shows none of them", exposes(detail.text));
        check(csv.status === 200 && exposes(csv.text).length === 0, "the deliveries CSV has none of them", exposes(csv.text));
        const linkedCode = Array.from(randomBytes(8), (b) => "23456789ABCDEFGHJKMNPQRSTUVWXYZ"[b % 31]).join("");
        await db().from("players").update({ access_code: linkedCode, access_code_hash: null, access_code_sealed: null }).eq("id", LINKED);
        const sendCodeR = await action(`${T}/[id]/players/actions.ts`, "sendCode", [null, form({ tournament_id: TA.id, player_id: LINKED, channel: "email" })], aAdmin.headers);
        const { count: toB } = await db().from("message_deliveries").select("id", { count: "exact", head: true }).eq("address", EMAIL2);
        check(/No email address/.test(sendCodeR.text) && toB === 0, "\"Send code\" for the linked row never uses B's player's email", sendCodeR.text.slice(0, 160));
        await db().from("matches").update({ status: "scheduled", started_at: null }).eq("id", TA.match);
        await db().from("tournaments").update({ match_day_rules: {} }).eq("id", TA.id);
      }
    }

    section("event codes scoped to one tournament, against another tournament of the same organisation");
    {
      const refT = await http("POST", "/api/mobile/v1/staff/session", {}, { code: codeArefT });
      check(refT.status === 200 && (refT.json?.scope as { tournamentId?: string } | null)?.tournamentId === TA.id, "A's referee code scoped to TA signs in with its scope");
      const scoped = bearer(String(refT.json?.token));
      const own = await http("POST", `/api/matches/${TA.match}/claim`, scoped, { deviceId: `e2e-scoped-${tag}`, deviceLabel: "E2E" });
      check(own.status === 200, "…claims a match of its own tournament", own.status);
      await http("POST", `/api/matches/${TA.match}/release-lease`, scoped, { deviceId: `e2e-scoped-${tag}` });
      for (const route of ["claim", "request-control", "events"]) {
        const r = await http("POST", `/api/matches/${TA2.match}/${route}`, scoped, { deviceId: `e2e-scoped-${tag}`, deviceLabel: "E2E", events: [] });
        check(r.status === 404, `…but not ${route} on A's other tournament's match`, r.status);
      }
      const boot = await http("GET", `/api/mobile/v1/referee/matches/${TA2.match}/bootstrap`, scoped);
      const picker = await http("GET", `/api/mobile/v1/referee/tournaments/${TA2.id}/matches`, scoped);
      check(boot.status === 404 && picker.status === 404, "…nor open its bootstrap or match picker", [boot.status, picker.status]);
      const { data: before2 } = await db().from("teams").select("check_in_status").eq("id", TA2.team1).single();
      const checkIn = await action(`${T}/[id]/teams/actions.ts`, "setCheckIn", [form({ tournament_id: TA2.id, team_id: TA2.team1, status: "no_show" })], scoped);
      const checkInOwn = await action(`${T}/[id]/teams/actions.ts`, "setCheckIn", [form({ tournament_id: TA.id, team_id: TA.team1, status: "checked_in" })], scoped);
      const { data: after2 } = await db().from("teams").select("check_in_status").eq("id", TA2.team1).single();
      check(actionRefused(checkIn) && JSON.stringify(before2) === JSON.stringify(after2), "…nor check in a team of A's other tournament (server action)", checkIn.text.slice(0, 120));
      // (The page the action is posted to then sends a referee elsewhere: the write is what counts.)
      const { data: ownTeam } = await db().from("teams").select("check_in_status").eq("id", TA.team1).single();
      check((ownTeam as { check_in_status: string }).check_in_status === "checked_in", "…while it checks in its own tournament's team", `${checkInOwn.status} ${checkInOwn.text.slice(0, 120)}`);
      const { data: screens0 } = await db().from("screen_settings").select("screen_key, revision").eq("tournament_id", TA2.id).order("screen_key");
      const add = await action("src/app/operator/tournaments/[id]/control/actions.ts", "addScreen", [null, form({ tournament_id: TA2.id, screen_name: "PWNED" })], aOperator.headers);
      const cmd = await action("src/app/operator/tournaments/[id]/control/actions.ts", "screenCommand", [null, form({ tournament_id: TA2.id, screen_key: "main", revision: "0", command: "mute_on" })], aOperator.headers);
      const { data: screens1 } = await db().from("screen_settings").select("screen_key, revision").eq("tournament_id", TA2.id).order("screen_key");
      check(actionRefused(add) && actionRefused(cmd) && JSON.stringify(screens0) === JSON.stringify(screens1), "A's operator code scoped to TA cannot add or command TA2's screens", [add.status, cmd.status]);
    }

    section("malformed signatures: 401, never 500");
    {
      const mb = (t: string) => `${t.slice(0, -1)}é`; // same string length, one more byte
      const a = await http("GET", "/api/mobile/v1/referee/tournaments", bearer(mb(String(refApp.json?.token))));
      const b = await http("GET", "/api/mobile/v1/referee/tournaments", bearer(mb(sessionToken("referee"))));
      const c = await http("GET", "/admin/tournaments", cookie(mb(aAdminWeb.token ?? "")));
      const d = await http("GET", "/admin/tournaments", cookie(mb(sessionToken("admin"))));
      const e = await fetch(`${BASE_URL}/staff/auth/callback?code=${randomUUID()}`, { redirect: "manual", headers: { Cookie: `mb_staff_oauth=${mb("e30.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG")}` } });
      check(a.status === 401 && b.status === 401, "a multi-byte signature on a staff token or a shared-password token is a 401", [a.status, b.status]);
      check(c.status === 307 && d.status === 307, "…and the same cookies send the page to the login", [c.status, d.status]);
      check(e.status === 302 && /error=signin_failed/.test(e.headers.get("location") ?? ""), "…and a multi-byte OAuth state cookie is refused cleanly", e.status);
    }

    section("login brakes: per address, never platform-wide");
    {
      const attacker = { "X-Forwarded-For": `203.0.113.${(randomBytes(1)[0] % 200) + 20}` };
      let last = 0;
      for (let i = 0; i < 21; i++) last = (await http("POST", "/api/mobile/v1/staff/session", attacker, { code: generateEventCode() })).status;
      const blocked = await http("POST", "/api/mobile/v1/staff/session", attacker, { code: codeLock });
      check(last === 429 && blocked.status === 429, "one address guessing codes is stopped (even with a right code)", [last, blocked.status]);
      const other = await http("POST", "/api/mobile/v1/staff/session", { "X-Forwarded-For": "192.0.2.77" }, { code: codeLock });
      check(other.status === 200, "…while a referee on another address signs in with their code", other.status);
    }

    section("the staff cookie off localhost is __Host-");
    {
      const host = "tour.mbeg.org";
      const plain = await rawGet("/admin/tournaments", host, { Cookie: `mb_session=${aAdminWeb.token}` });
      const hostPrefixed = await rawGet("/admin/tournaments", host, { Cookie: `__Host-mb_session=${aAdminWeb.token}` });
      check(plain.status === 307 && /\/login/.test(plain.location), "off localhost a plain mb_session cookie is not read (a sibling subdomain could have set it)", plain.status);
      check(hostPrefixed.status === 200, "…the __Host- cookie is", hostPrefixed.status);
      const start = await fetch(`${BASE_URL}/staff/auth/google?next=${encodeURIComponent("/admin/tournaments")}`, { redirect: "manual" });
      const state = (start.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("mb_staff_oauth="))?.split(";")[0] ?? "";
      const authorize = new URL(start.headers.get("location") ?? "");
      authorize.searchParams.set("login_hint", `e2e.a.admin.${tag}@example.com`);
      const back = await fetch(authorize, { redirect: "manual" });
      const cb = new URL(back.headers.get("location") ?? "");
      const signed = await rawGet(`${cb.pathname}${cb.search}`, host, { Cookie: state });
      const set = signed.setCookie.find((c) => /^(__Host-)?mb_session=/.test(c)) ?? "";
      check(/^__Host-mb_session=mbs1\./.test(set) && /;\s*Secure/i.test(set) && /;\s*Path=\//i.test(set) && !/;\s*Domain=/i.test(set) && /HttpOnly/i.test(set), "a sign-in off localhost sets __Host-mb_session (Secure, Path=/, no Domain, HttpOnly)", set.replace(/=mbs1\.[^;]*/, "=mbs1.…"));
    }

    section("tokens and codes");
    {
      const parts = (aAdminWeb.token ?? "").split(".");
      const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
      const forgedBody = Buffer.from(JSON.stringify({ ...payload, o: B, r: "owner" })).toString("base64url");
      const forged = `${parts[0]}.${forgedBody}.${parts[2]}`;
      const f1 = await http("GET", `/admin/tournaments/${TB.id}`, cookie(forged));
      check(f1.status === 307 && f1.location.includes("/login") && !leaked(f1.text), "a forged cookie (org changed to B) is refused", f1.status);
      const f2 = await http("GET", "/api/mobile/v1/referee/tournaments", bearer(forged));
      check(f2.status === 401, "…and as a bearer", f2.status);
      const otherSecret = signStaffToken({ v: 1, k: "m", u: aAdminUser.id, o: B, r: "owner", iat: Date.now(), exp: Date.now() + 3600_000 }, "x".repeat(48));
      check((await http("GET", "/api/mobile/v1/referee/tournaments", bearer(otherSecret))).status === 401, "a token signed with another secret is refused");
      const expired = staffToken({ kind: "member", userId: aAdminUser.id, orgId: A, role: "admin" }, { now: Date.now() - 25 * 3600_000, hours: 24 });
      check((await http("GET", "/admin/tournaments", cookie(expired))).status === 307, "an expired staff cookie is refused");
      const intruder = staffToken({ kind: "member", userId: bOwnerUser.id, orgId: A, role: "owner" });
      const i1 = await http("GET", `/admin/tournaments/${TA.id}`, cookie(intruder));
      check(i1.status === 307 && /error=membership_ended/.test(i1.location), "a validly signed token for an organisation the person is not in is refused", i1.location);
      const userJwt = await http("GET", "/api/mobile/v1/referee/tournaments", bearer(aAdminUser.accessToken));
      check(userJwt.status === 401, "a user's Supabase token is never a staff token", userJwt.status);
      const me = await http("GET", "/api/mobile/v1/me", bearer(String(refApp.json?.token)));
      const meAsUser = await http("GET", "/api/mobile/v1/me", bearer(aAdminUser.accessToken));
      check(me.status !== 200 && meAsUser.status === 200, "a staff token is never a user's session (/me)", [me.status, meAsUser.status]);
      const codeForB = staffToken({ kind: "code", codeId: CAref, orgId: B, role: "referee" });
      check((await http("GET", "/api/mobile/v1/referee/tournaments", bearer(codeForB))).status === 401, "A's code relabelled for org B is refused");
    }
    {
      await db().from("organization_codes").update({ revoked_at: new Date().toISOString() }).eq("id", CAref);
      const r = await http("GET", "/api/mobile/v1/referee/tournaments", aReferee.headers);
      check(r.status === 401 && r.json?.code === "code_revoked" && /revoked/i.test(String(r.json?.error)), "a revoked code fails the very next request with a clear message", r.json);
      const ev = await http("POST", `/api/matches/${TA.match}/events`, aReferee.headers, { deviceId, events: [{ client_event_id: randomUUID(), event_number: 1, event_type: "MATCH_STARTED", team_id: null, previous_state: null, new_state: {}, payload: null, created_at_client: new Date().toISOString() }] });
      check(ev.status === 401, "…including scoring (the app keeps its queue and asks for a new code)", ev.status);
      const again = await http("POST", "/api/mobile/v1/staff/session", {}, { code: codeAref });
      check(again.status === 401 && /revoked/i.test(String(again.json?.error)), "signing in again with the revoked code is refused", again.json?.error);
      const webPage = await http("GET", "/referee", cookie(String(refApp.json?.token)));
      check(webPage.status === 307 && /error=code_revoked/.test(webPage.location), "on the web the revoked code goes back to the login with the reason", webPage.location);
    }
    {
      await db().from("organization_codes").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("id", CB);
      const r = await http("GET", "/api/mobile/v1/referee/tournaments", bearer(String(bRef.json?.token)));
      check(r.status === 401 && r.json?.code === "code_expired", "an expired code fails the next request", r.json?.code);
    }
    {
      await db().from("organization_members").update({ status: "removed" }).eq("organization_id", A).eq("auth_user_id", aManagerUser.id);
      const r = await http("GET", "/admin/tournaments", aManager.headers);
      check(r.status === 307 && /error=membership_ended/.test(r.location), "removing a member takes effect on the next request", r.location);
      const act = await action(`${T}/[id]/settings/actions.ts`, "updateGeneral", [form({ tournament_id: TA.id, name: "removed member", lower_third_text: "x" })], aManager.headers);
      const { data: ta } = await db().from("tournaments").select("name").eq("id", TA.id).single();
      check(!actionOk(act) && (ta as { name: string }).name === `Alpha Open ${tag}`, "…for server actions too");
    }
    {
      await db().from("organizations").update({ status: "suspended" }).eq("id", A);
      const r = await http("GET", "/admin/tournaments", aAdmin.headers);
      check(r.status === 307 && /error=org_suspended/.test(r.location), "suspending the organisation takes effect on the next request", r.location);
      const op = await http("GET", "/operator", aOperator.headers);
      check(op.status === 307, "…for its event codes too", op.status);
      await db().from("organizations").update({ status: "approved" }).eq("id", A);
      const back = await http("GET", "/admin/tournaments", aAdmin.headers);
      check(back.status === 200, "approved again, the same cookie works");
    }
    {
      const { data: rows } = await db().from("audit_logs").select("organization_id, actor_user_id, actor_role, action").eq("organization_id", A).eq("action", "TOURNAMENT_SETTINGS_UPDATED");
      const row = ((rows ?? []) as { actor_user_id: string | null; actor_role: string | null }[])[0];
      check(Boolean(row) && row!.actor_user_id === aManagerUser.id && row!.actor_role === "manager", "audit rows record the organisation, the actor's user and role", row);
      const { data: login } = await db().from("audit_logs").select("new_value, entity_id").eq("organization_id", A).eq("action", "LOGIN");
      const raw = JSON.stringify(login ?? []);
      check(!raw.includes(codeAref) && !raw.includes(formatEventCode(codeAref)) && !raw.includes(hashEventCode(codeAref)), "no code (or its hash) is written to the audit log");
    }

    section("the shared admin password cannot manage members or the profile (M2)");
    {
      const mbUser = await standinUser(`e2e.mb.member.${tag}@example.com`);
      const { data: mbm } = await db().from("organization_members").insert({ organization_id: MB, auth_user_id: mbUser.id, invited_email: `e2e.mb.member.${tag}@example.com`, role: "manager", status: "active" }).select("id").single();
      const MBM = (mbm as { id: string }).id;
      created.mbMembers.push(MBM);
      const { data: mbBefore } = await db().from("organizations").select("name, about").eq("id", MB).single();
      const pages = await Promise.all(["/admin/org/members", "/admin/org/profile"].map((p) => http("GET", p, mbShared.headers)));
      check(pages.every((r) => r.status === 404 || r.status === 307), "the members and profile pages are not the shared password's", pages.map((r) => r.status));
      const M_ = "src/app/admin/org/members/actions.ts";
      const inv = await action(M_, "inviteMember", [null, form({ email: `e2e.shared.self.${tag}@example.com`, role: "manager" })], mbShared.headers);
      const { count: sharedInvites } = await db().from("organization_invites").select("id", { count: "exact", head: true }).eq("email", `e2e.shared.self.${tag}@example.com`);
      check(actionRefused(inv) && sharedInvites === 0, "it cannot invite anyone (its holder's own email included) into Move Beyond", inv.text.slice(0, 120));
      const demote = await action(M_, "changeMemberRole", [null, form({ member_id: MBM, role: "referee" })], mbShared.headers);
      const remove = await action(M_, "removeMember", [null, form({ member_id: MBM })], mbShared.headers);
      const { data: mbmNow } = await db().from("organization_members").select("role, status").eq("id", MBM).single();
      check(actionRefused(demote) && actionRefused(remove) && JSON.stringify(mbmNow) === JSON.stringify({ role: "manager", status: "active" }), "it cannot demote or remove Move Beyond's members", mbmNow);
      const rebrand = await action("src/app/admin/org/profile/actions.ts", "updateOrgProfile", [null, form({ organization_id: MB, name: (mbBefore as { name: string }).name, about: `PWNED ${tag}` })], mbShared.headers);
      const { data: mbAfter } = await db().from("organizations").select("name, about").eq("id", MB).single();
      check(actionRefused(rebrand) && JSON.stringify(mbAfter) === JSON.stringify(mbBefore), "it cannot rebrand Move Beyond", rebrand.text.slice(0, 120));
      if (JSON.stringify(mbAfter) !== JSON.stringify(mbBefore)) await db().from("organizations").update(mbBefore as Record<string, unknown>).eq("id", MB);
      const own = await http("GET", "/admin/tournaments", mbShared.headers);
      check(own.status === 200, "…while it still runs Move Beyond's tournaments", own.status);
    }

    /* ================= Part B: onboarding, invites, members, profile, app ================= */

    // Either link form, so the attack checks also run against an older build (proof runs).
    const INVITE_RE = /invite\/open[#?]t=([A-Za-z0-9_-]{43})/;
    const tokenIn = (text: string) => INVITE_RE.exec(text)?.[1] ?? null;
    const cookiesFrom = (res: Response, ...names: string[]) =>
      (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]!).filter((c) => names.some((n) => c.startsWith(`${n}=`)));
    /** A browser's cookie jar: later Set-Cookie headers replace earlier values (an empty value deletes). */
    const jar = (into: Map<string, string>, res: Response) => {
      for (const c of (res.headers.getSetCookie?.() ?? []).map((x) => x.split(";")[0]!)) {
        const [k, ...v] = c.split("=");
        if (v.join("=")) into.set(k!, v.join("="));
        else into.delete(k!);
      }
      return into;
    };
    const cookieHeader = (j: Map<string, string>) => [...j].map(([k, v]) => `${k}=${v}`).join("; ");
    /** What /invite/open's page does with the link's fragment: a same-origin POST of the token. */
    async function openInvite(token: string, origin = BASE_URL): Promise<Response> {
      return fetch(`${BASE_URL}/invite/open`, { method: "POST", redirect: "manual", headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, body: `t=${encodeURIComponent(token)}` });
    }
    /** How an attacker plants an invite in someone's browser: whatever this server offers (the POST, or an older build's GET ?t=). */
    async function plantInvite(token: string): Promise<Map<string, string>> {
      const viaPost = jar(new Map(), await openInvite(token));
      if (viaPost.has("mb_invite")) return viaPost;
      return jar(new Map(), await fetch(`${BASE_URL}/invite/open?t=${token}`, { redirect: "manual" }));
    }
    /** A staff sign-in with Google in a browser holding `cookies` (an invite, say). Returns the jar after it. */
    async function googleIn(email: string, cookies: Map<string, string>, next = "/admin/tournaments"): Promise<{ landed: string; jar: Map<string, string>; res: Response }> {
      const start = await fetch(`${BASE_URL}/staff/auth/google?next=${encodeURIComponent(next)}`, { redirect: "manual" });
      const state = cookiesFrom(start, "mb_staff_oauth")[0] ?? "";
      const authorize = new URL(start.headers.get("location") ?? "");
      authorize.searchParams.set("login_hint", email);
      const back = await fetch(authorize, { redirect: "manual" });
      // Each browser from its own address (the callback has a per-address brake of its own).
      const cb = await fetch(back.headers.get("location") ?? "", { redirect: "manual", headers: { Cookie: [state, cookieHeader(cookies)].filter(Boolean).join("; "), "X-Forwarded-For": `192.0.2.${(randomBytes(1)[0] % 200) + 20}` } });
      return { landed: cb.headers.get("location") ?? "", jar: jar(new Map(cookies), cb), res: cb };
    }
    /** POST /invite/accept or /invite/decline, the way the "Join … ?" page's buttons do. */
    async function answer(which: "accept" | "decline", cookies: Map<string, string>, origin = BASE_URL) {
      const res = await fetch(`${BASE_URL}/invite/${which}`, { method: "POST", redirect: "manual", headers: { Origin: origin, Cookie: cookieHeader(cookies), "Content-Type": "application/x-www-form-urlencoded" }, body: "" });
      return { landed: res.headers.get("location") ?? "", jar: jar(new Map(cookies), res), res };
    }
    /**
     * Opens an invite link (when given), signs in with Google as `email` in the same
     * browser and, when the sign-in asks "Join … ?", answers Accept. Returns the staff
     * cookie it ends with and where it landed.
     */
    async function inviteSignIn(token: string | null, email: string, opts: { accept?: boolean } = {}): Promise<{ token: string | null; landed: string; asked: boolean; jar: Map<string, string> }> {
      let j = new Map<string, string>();
      if (token) j = await plantInvite(token);
      const signed = await googleIn(email, j);
      j = signed.jar;
      const asked = signed.landed.endsWith("/invite");
      let landed = signed.landed;
      if (asked && opts.accept !== false) {
        const a = await answer("accept", j);
        j = a.jar;
        landed = a.landed;
      }
      return { token: j.get("mb_session") ?? null, landed, asked, jar: j };
    }
    const P = "src/app/admin/platform/organizations/actions.ts";
    const M = "src/app/admin/org/members/actions.ts";

    section("onboarding: an organisation applies");
    const applicant = `e2e.applicant.${tag}@example.com`;
    const cName = `E2E Club C ${tag}`;
    let C = "";
    let C_SLUG = "";
    const ip = { "X-Forwarded-For": `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0] % 200) + 20}` };
    const apply = (o: Record<string, string>, who: Record<string, string> = ip) => action("src/app/organizations/apply/actions.ts", "applyAction", [null, form(o)], who);
    {
      const r = await apply({ name: cName, contact_name: "Cee Applicant", contact_email: applicant.toUpperCase(), city: "Giza", country: "Egypt", about: `About C ${tag}`, password: "hunter2-secret", via: "app" });
      check(r.status === 200 && /"ok":true/.test(r.text), "the public form takes an application", r.text.slice(0, 160));
      const { data: rows } = await db().from("organizations").select("id, slug, status, application").eq("name", cName);
      const row = ((rows ?? []) as { id: string; slug: string; status: string; application: Record<string, unknown> }[])[0];
      C = row?.id ?? "";
      C_SLUG = row?.slug ?? "";
      if (C) created.orgs.push(C);
      check(row?.status === "applied" && row.application.contact_email === applicant && row.application.via === "app", "it is stored as 'applied', with the contact email lower-cased", row);
      check(!JSON.stringify(row?.application ?? {}).includes("hunter2"), "fields the form does not know (a 'password') are never stored");
      const bot = await apply({ name: `E2E Bot ${tag}`, contact_name: "Bot", contact_email: `bot.${tag}@example.com`, company_fax: "x" }, { "X-Forwarded-For": "198.18.0.9" });
      const { count: botRows } = await db().from("organizations").select("id", { count: "exact", head: true }).eq("name", `E2E Bot ${tag}`);
      check(/"ok":true/.test(bot.text) && botRows === 0, "a bot filling the hidden field gets the same answer and stores nothing");
      const big = await apply({ name: `E2E Big ${tag}`, contact_name: "Big", contact_email: `big.${tag}@example.com`, about: "x".repeat(7000) }, { "X-Forwarded-For": "198.18.0.10" });
      check(/"ok":false/.test(big.text), "an oversized application is refused", big.text.slice(0, 120));
      const flood = { "X-Forwarded-For": `198.18.1.${(randomBytes(1)[0] % 200) + 20}` };
      let last = "";
      for (let i = 0; i < 6; i++) last = (await apply({ name: `E2E Flood ${tag} ${i}`, contact_name: "F", contact_email: `flood${i}.${tag}@example.com` }, flood)).text;
      check(/"ok":false/.test(last) && /Too many/.test(last), "applications are rate-limited per network address", last.slice(0, 120));
      const { data: floodRows } = await db().from("organizations").select("id").like("name", `E2E Flood ${tag}%`);
      created.orgs.push(...((floodRows ?? []) as { id: string }[]).map((o) => o.id));
      const pending = await http("GET", `/api/mobile/v1/orgs/${C_SLUG}`);
      check(pending.status === 404, "an organisation that only applied has no public page", pending.status);
      check(/^applied-[0-9a-f]+$/.test(C_SLUG) && !C_SLUG.includes("club-c"), "an application holds no slug made from its name (a placeholder until approval)", C_SLUG);
      for (const [label, name] of [["Move Beyond's name", "MOVE   beyond"], ["another organisation's name", `e2e club a ${tag}`], ["a web address", "https://evil.example/login"]] as const) {
        const before = (await db().from("organizations").select("id", { count: "exact", head: true }).eq("name", name)).count;
        const r = await apply({ name, contact_name: "Imp", contact_email: `imp.${randomBytes(3).toString("hex")}.${tag}@example.com` }, { "X-Forwarded-For": `198.18.3.${(randomBytes(1)[0] % 200) + 20}` });
        const after = (await db().from("organizations").select("id", { count: "exact", head: true }).eq("name", name)).count;
        check(/"ok":false/.test(r.text) && after === before, `an application under ${label} is refused`, r.text.slice(0, 140));
      }
    }

    section("onboarding: only platform admins decide");
    const platformUser = await standinUser(`e2e.platform.${tag}@example.com`);
    await db().from("platform_admins").insert({ auth_user_id: platformUser.id, email: `e2e.platform.${tag}@example.com`, note: "e2e" });
    let platform: Record<string, string> = {};
    try {
      const pw = await webGoogleSignIn(`e2e.platform.${tag}@example.com`);
      platform = cookie(pw.token ?? "");
      for (const who of [aAdmin, mbShared, { label: "B owner", headers: cookie(bOwnerWeb.token ?? "") }]) {
        const r = await action(P, "decideApplication", [null, form({ org_id: C, decision: "approve" })], who.headers);
        const { data: st } = await db().from("organizations").select("status").eq("id", C).single();
        check(actionRefused(r) && (st as { status: string }).status === "applied", `${who.label} cannot approve an application`, r.text.slice(0, 120));
      }
      const page = await http("GET", "/admin/platform/organizations", platform);
      check(page.status === 200 && page.text.includes(cName) && page.text.includes(applicant), "a platform admin sees the application", page.status);
      const approve = await action(P, "decideApplication", [null, form({ org_id: C, decision: "approve", invite_role: "owner" })], platform);
      const ownerToken = tokenIn(approve.text);
      const { data: st } = await db().from("organizations").select("status").eq("id", C).single();
      check(actionOk(approve) && (st as { status: string }).status === "approved" && Boolean(ownerToken), "the platform admin approves it; the applicant is invited as owner (link shown once)", approve.text.slice(0, 200));
      C_SLUG = ((await db().from("organizations").select("slug").eq("id", C).single()).data as { slug: string }).slug;
      check(C_SLUG === `e2e-club-c-${tag}`, "…and only now gets its slug, from its name", C_SLUG);
      const { data: decided } = await db().from("audit_logs").select("actor_role, actor_user_id").eq("organization_id", C).eq("action", "ORGANIZATION_APPROVED");
      const dRow0 = ((decided ?? []) as { actor_role: string | null; actor_user_id: string | null }[])[0];
      check(dRow0?.actor_role === "platform" && dRow0.actor_user_id === platformUser.id, "the approval is audited as the platform admin (\"platform\"), never as the organisation's owner", dRow0);
      {
        // A turned-down application never kept its name's address.
        const rName = `E2E Club R ${tag}`;
        await apply({ name: rName, contact_name: "R", contact_email: `r.${tag}@example.com` }, { "X-Forwarded-For": `198.18.4.${(randomBytes(1)[0] % 200) + 20}` });
        const { data: rRow } = await db().from("organizations").select("id").eq("name", rName).maybeSingle();
        if (rRow) created.orgs.push((rRow as { id: string }).id);
        await action(P, "decideApplication", [null, form({ org_id: (rRow as { id: string } | null)?.id ?? "", decision: "reject" })], platform);
        const made = await action(P, "createOrganization", [null, form({ name: rName, invite_email: `r.owner.${tag}@example.com`, invite_role: "owner" })], platform);
        const { data: madeRow } = await db().from("organizations").select("id, slug").eq("name", rName).eq("status", "approved").maybeSingle();
        if (madeRow) created.orgs.push((madeRow as { id: string }).id);
        check(actionOk(made) && (madeRow as { slug: string } | null)?.slug === `e2e-club-r-${tag}`, "a turned-down application holds no slug: the name's slug is free for the real organisation", [made.text.slice(0, 120), madeRow]);
      }
      const { data: inv } = await db().from("organization_invites").select("id, email, role, token_hash, expires_at").eq("organization_id", C);
      const invites = (inv ?? []) as { id: string; email: string; role: string; token_hash: string; expires_at: string }[];
      check(invites.length === 1 && invites[0]!.email === applicant && invites[0]!.role === "owner", "one invite, bound to the applicant's email, as owner", invites);
      check(!JSON.stringify(invites).includes(ownerToken ?? "§"), "the invite token itself is not stored (only its HMAC)");
      const days = (Date.parse(invites[0]?.expires_at ?? "") - Date.now()) / 86_400_000;
      check(days > 6.9 && days <= 7.01, "it expires in 7 days", days);
      const { data: deliveries } = await db().from("message_deliveries").select("status, vars, payload, purpose").eq("address", applicant);
      const dl = (deliveries ?? []) as { status: string; purpose: string }[];
      check(dl.some((d) => d.purpose === "staff_invite" && d.status === "sent"), "the invite was emailed (dry run) with the branded layout", dl.map((d) => `${d.purpose}:${d.status}`));
      check(!JSON.stringify(deliveries).includes(ownerToken ?? "§") && JSON.stringify(deliveries).includes("[removed]"), "message_deliveries keeps the email without the link or token");
      const { data: auditRows } = await db().from("audit_logs").select("new_value, old_value").eq("organization_id", C);
      check(!JSON.stringify(auditRows ?? []).includes(ownerToken ?? "§"), "no invite token in the audit log");

      section("invites: accepted only by the invited email, once");
      check(/invite\/open#t=/.test(approve.text) && !/invite\/open\?t=/.test(approve.text), "the link carries its token in the fragment, never the query string (no server, proxy log or Referer sees it)");
      const wrong = await inviteSignIn(ownerToken, `e2e.someone.else.${tag}@example.com`);
      const { count: wrongMembers } = await db().from("organization_members").select("id", { count: "exact", head: true }).eq("organization_id", C);
      check(!wrong.token && /\/invite\?error=wrong_email/.test(wrong.landed) && wrongMembers === 0, "signing in with another email is refused; no membership", wrong.landed);
      check(!wrong.jar.has("mb_invite"), "…and that browser forgets the invite (a wrong-email cookie never lingers)", [...wrong.jar.keys()]);
      const { data: still } = await db().from("organization_invites").select("accepted_at").eq("organization_id", C).single();
      check((still as { accepted_at: string | null }).accepted_at === null, "…and the invite stays usable for the right person");
      const landing = await fetch(`${BASE_URL}/invite/open?t=${ownerToken}`, { redirect: "manual" });
      const landingHtml = await landing.text();
      check(landing.status === 200 && (landing.headers.getSetCookie?.() ?? []).length === 0 && !landingHtml.includes(ownerToken ?? "§") && /no-referrer/.test(landing.headers.get("referrer-policy") ?? ""), "the link's page reads the fragment in the browser; a token in the query string is never read or set", landing.status);
      const invitePage = await openInvite(ownerToken ?? "");
      const ic = cookiesFrom(invitePage, "mb_invite")[0] ?? "";
      check(invitePage.status === 303 && (invitePage.headers.get("location") ?? "").endsWith("/invite") && /HttpOnly/i.test((invitePage.headers.getSetCookie?.() ?? []).join(";")), "the page hands the token over in a POST that moves it into an httpOnly cookie", invitePage.headers.get("location"));
      const crossSite = await openInvite(ownerToken ?? "", "https://evil.example");
      check(cookiesFrom(crossSite, "mb_invite").length === 0 && /error=invalid/.test(crossSite.headers.get("location") ?? ""), "…only from this site (another origin's POST sets nothing)");
      const shown = await http("GET", "/invite", { Cookie: ic });
      check(shown.status === 200 && shown.text.includes(cName) && !shown.text.includes(applicant) && !shown.text.includes(ownerToken ?? "§"), "the invite page names the organisation, masks the email and never echoes the token");
      const noAsk = await answer("accept", new Map([[ic.split("=")[0]!, ic.slice(ic.indexOf("=") + 1)]]));
      const { count: noAskMembers } = await db().from("organization_members").select("id", { count: "exact", head: true }).eq("organization_id", C);
      check(/error=invalid/.test(noAsk.landed) && noAskMembers === 0, "Accept without signing in as the invited address does nothing", noAsk.landed);
      const ownerAsked = await inviteSignIn(ownerToken, applicant, { accept: false });
      const { count: beforeAccept } = await db().from("organization_members").select("id", { count: "exact", head: true }).eq("organization_id", C);
      check(ownerAsked.asked && beforeAccept === 0, "signing in as the invited address asks first: nothing is written by the sign-in", ownerAsked.landed);
      const askPage = await http("GET", "/invite", { Cookie: cookieHeader(ownerAsked.jar) });
      check(askPage.text.includes(`Join ${cName} as owner?`) && askPage.text.includes("invite-accept") && askPage.text.includes("invite-decline"), "the page asks \"Join … as owner?\" with Accept and Not now");
      const forgedOrigin = await answer("accept", ownerAsked.jar, "https://evil.example");
      const { count: afterForged } = await db().from("organization_members").select("id", { count: "exact", head: true }).eq("organization_id", C);
      check(afterForged === 0, "Accept posted from another site does nothing", forgedOrigin.landed);
      const accepted = await answer("accept", ownerAsked.jar);
      const owner = { token: accepted.jar.get("mb_session") ?? null, landed: accepted.landed };
      check(Boolean(owner.token?.startsWith("mbs1.")) && owner.landed.endsWith("/admin/tournaments"), "Accept: the applicant is let in", owner.landed);
      const { data: mem } = await db().from("organization_members").select("id, role, status, auth_user_id").eq("organization_id", C);
      const members = (mem ?? []) as { id: string; role: string; status: string; auth_user_id: string }[];
      check(members.length === 1 && members[0]!.role === "owner" && members[0]!.status === "active", "the membership activates as owner", members);
      const { data: accAudit } = await db().from("audit_logs").select("actor_user_id, actor_role").eq("organization_id", C).eq("action", "INVITE_ACCEPTED");
      check(((accAudit ?? []) as { actor_user_id: string | null }[]).some((r) => r.actor_user_id === members[0]?.auth_user_id), "INVITE_ACCEPTED records who accepted (actor_user_id)", accAudit);
      const cOwner = cookie(owner.token ?? "");
      const home = await http("GET", "/admin/tournaments", cOwner);
      check(home.status === 200 && home.text.includes(cName) && !home.text.includes(`Alpha Open ${tag}`), "the new owner works in C's console (and sees none of A's)");
      const reuse = await inviteSignIn(ownerToken, applicant);
      const { count: reuseMembers } = await db().from("organization_members").select("id", { count: "exact", head: true }).eq("organization_id", C);
      check(!reuse.asked && reuse.landed.endsWith("/admin/tournaments") && reuseMembers === 1 && !reuse.jar.has("mb_invite"), "a used invite asks nothing again: the sign-in goes on as usual and the browser forgets it", reuse.landed);
      const forged = await inviteSignIn("A".repeat(43), applicant);
      check(!forged.asked && forged.landed.endsWith("/admin/tournaments") && !forged.jar.has("mb_invite"), "a forged invite token is ignored (and forgotten); the sign-in goes on", forged.landed);
      const malformed = await openInvite("short");
      check(/error=invalid/.test(malformed.headers.get("location") ?? "") && cookiesFrom(malformed, "mb_invite").length === 0, "a malformed token never becomes a cookie");

      section("members: invite, roles, removal, last owner");
      const mgrEmail = `e2e.c.manager.${tag}@example.com`;
      const inv1 = await action(M, "inviteMember", [null, form({ email: mgrEmail, role: "manager" })], cOwner);
      const revokedToken = tokenIn(inv1.text);
      check(actionOk(inv1) && Boolean(revokedToken), "C's owner invites a manager", inv1.text.slice(0, 160));
      const { data: openInv } = await db().from("organization_invites").select("id").eq("organization_id", C).eq("email", mgrEmail).is("revoked_at", null).single();
      const revokeIt = await action(M, "revokeInvite", [null, form({ invite_id: (openInv as { id: string }).id })], cOwner);
      check(actionOk(revokeIt) && /"ok":true/.test(revokeIt.text), "…and withdraws it", revokeIt.text.slice(0, 120));
      const revoked = await inviteSignIn(revokedToken, mgrEmail);
      check(/\/invite\?error=revoked/.test(revoked.landed) && !revoked.token, "a withdrawn invite is refused", revoked.landed);
      const inv2 = await action(M, "inviteMember", [null, form({ email: mgrEmail, role: "manager" })], cOwner);
      const expiredToken = tokenIn(inv2.text);
      await db().from("organization_invites").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("organization_id", C).eq("email", mgrEmail).is("revoked_at", null);
      const expired = await inviteSignIn(expiredToken, mgrEmail);
      check(/\/invite\?error=expired/.test(expired.landed) && !expired.token, "an expired invite is refused", expired.landed);
      const inv3 = await action(M, "inviteMember", [null, form({ email: mgrEmail, role: "manager" })], cOwner);
      const mgr = await inviteSignIn(tokenIn(inv3.text), mgrEmail);
      check(Boolean(mgr.token?.startsWith("mbs1.")), "a fresh invite works for the manager", mgr.landed);
      const cManager = cookie(mgr.token ?? "");
      const mgrHome = await http("GET", "/admin/tournaments", cManager);
      const mgrMembers = await http("GET", "/admin/org/members", cManager);
      check(mgrHome.status === 200 && mgrMembers.status === 404, "the manager works in C, but the members page is not theirs", [mgrHome.status, mgrMembers.status]);
      const mgrInvite = await action(M, "inviteMember", [null, form({ email: `x.${tag}@example.com`, role: "referee" })], cManager);
      check(actionRefused(mgrInvite), "a manager cannot invite", mgrInvite.text.slice(0, 120));

      const admEmail = `e2e.c.admin.${tag}@example.com`;
      const inv4 = await action(M, "inviteMember", [null, form({ email: admEmail, role: "admin" })], cOwner);
      const adm = await inviteSignIn(tokenIn(inv4.text), admEmail);
      const cAdmin = cookie(adm.token ?? "");
      check(Boolean(adm.token), "C's owner invites an admin, who accepts");
      const { data: memRows } = await db().from("organization_members").select("id, role, invited_email").eq("organization_id", C).eq("status", "active");
      const byEmail = new Map(((memRows ?? []) as { id: string; role: string; invited_email: string }[]).map((m) => [m.invited_email, m]));
      const ownerMember = byEmail.get(applicant)!;
      const mgrMember = byEmail.get(mgrEmail)!;
      const admMember = byEmail.get(admEmail)!;
      const admOwnerInvite = await action(M, "inviteMember", [null, form({ email: `o.${tag}@example.com`, role: "owner" })], cAdmin);
      const admAdminInvite = await action(M, "inviteMember", [null, form({ email: `o.${tag}@example.com`, role: "admin" })], cAdmin);
      check(actionRefused(admOwnerInvite) && actionRefused(admAdminInvite), "an admin cannot invite owners or admins");
      const demoteOwner = await action(M, "changeMemberRole", [null, form({ member_id: ownerMember.id, role: "manager" })], cAdmin);
      const removeOwner = await action(M, "removeMember", [null, form({ member_id: ownerMember.id })], cAdmin);
      check(actionRefused(demoteOwner) && actionRefused(removeOwner), "an admin cannot demote or remove the owner");
      const promote = await action(M, "changeMemberRole", [null, form({ member_id: mgrMember.id, role: "admin" })], cAdmin);
      check(actionRefused(promote), "an admin cannot make someone an admin");
      const toRef = await action(M, "changeMemberRole", [null, form({ member_id: mgrMember.id, role: "referee" })], cAdmin);
      const { data: mgrNow } = await db().from("organization_members").select("role").eq("id", mgrMember.id).single();
      check(actionOk(toRef) && (mgrNow as { role: string }).role === "referee", "an admin can make the manager a referee", toRef.text.slice(0, 120));
      const selfDemote = await action(M, "changeMemberRole", [null, form({ member_id: ownerMember.id, role: "admin" })], cOwner);
      const selfRemove = await action(M, "removeMember", [null, form({ member_id: ownerMember.id })], cOwner);
      const { data: ownerNow } = await db().from("organization_members").select("role, status").eq("id", ownerMember.id).single();
      check(actionRefused(selfDemote) && actionRefused(selfRemove) && /at least one owner/.test(selfDemote.text) && JSON.stringify(ownerNow) === JSON.stringify({ role: "owner", status: "active" }), "nobody can demote or remove the last owner", selfDemote.text.slice(0, 160));
      const { error: dbLast } = await db().from("organization_members").update({ role: "admin" }).eq("id", ownerMember.id);
      check(Boolean(dbLast) && /owner/.test(dbLast?.message ?? ""), "…the database refuses it too (trigger)", dbLast?.message);
      const ownerDemotes = await action(M, "changeMemberRole", [null, form({ member_id: admMember.id, role: "manager" })], cOwner);
      const { data: admNow } = await db().from("organization_members").select("role").eq("id", admMember.id).single();
      check(actionOk(ownerDemotes) && (admNow as { role: string }).role === "manager", "the owner can change an admin's role", ownerDemotes.text.slice(0, 120));
      const removeRef = await action(M, "removeMember", [null, form({ member_id: mgrMember.id })], cOwner);
      const refGone = await http("GET", "/admin/tournaments", cManager);
      check(actionOk(removeRef) && refGone.status === 307 && /membership_ended/.test(refGone.location), "a removed member is out on their next request", refGone.location);

      section("invites never undo an owner's invite, demote anyone, or outlive their sender (L2)");
      const adm2Email = `e2e.c.admin2.${tag}@example.com`;
      const adm3Email = `e2e.c.admin3.${tag}@example.com`;
      const adm2 = await inviteSignIn(tokenIn((await action(M, "inviteMember", [null, form({ email: adm2Email, role: "admin" })], cOwner)).text), adm2Email);
      const adm3 = await inviteSignIn(tokenIn((await action(M, "inviteMember", [null, form({ email: adm3Email, role: "admin" })], cOwner)).text), adm3Email);
      const cAdmin2 = cookie(adm2.token ?? "");
      const cAdmin3 = cookie(adm3.token ?? "");
      check(Boolean(adm2.token && adm3.token), "C's owner invites two more admins, who accept");
      const memberOf = async (email: string) =>
        ((await db().from("organization_members").select("id, role, status, auth_user_id").eq("organization_id", C).eq("invited_email", email).maybeSingle()).data as { id: string; role: string; status: string; auth_user_id: string } | null);
      {
        const vip = `e2e.c.vip.${tag}@example.com`;
        await action(M, "inviteMember", [null, form({ email: vip, role: "admin" })], cOwner);
        const over = await action(M, "inviteMember", [null, form({ email: vip, role: "manager" })], cAdmin2);
        const { data: vipInv } = await db().from("organization_invites").select("role, revoked_at").eq("organization_id", C).eq("email", vip);
        const rows = (vipInv ?? []) as { role: string; revoked_at: string | null }[];
        check(/"ok":false/.test(over.text) && rows.some((r) => r.role === "admin" && r.revoked_at === null), "an admin cannot withdraw an owner's invite of an admin by inviting the same address", rows);
      }
      {
        // adm3's member row names another address (an account whose email changed, say): the
        // "already a member" check cannot see them, so an admin's invite gets through …
        const a3Before = await memberOf(adm3Email);
        await db().from("organization_members").update({ invited_email: `e2e.c.legacy3.${tag}@example.com` }).eq("id", a3Before?.id ?? "");
        const lower = await action(M, "inviteMember", [null, form({ email: adm3Email, role: "manager" })], cAdmin2);
        const r = await inviteSignIn(tokenIn(lower.text), adm3Email);
        const { data: a3 } = await db().from("organization_members").select("role").eq("id", a3Before?.id ?? "").single();
        const a3Role = (a3 as { role: string } | null)?.role;
        check(Boolean(tokenIn(lower.text)) && a3Role === "admin", "… but accepting it never lowers an admin to manager", [r.landed, a3Role]);
        await db().from("organization_members").update({ invited_email: adm3Email }).eq("id", a3Before?.id ?? "");
      }
      {
        const late = `e2e.c.late.${tag}@example.com`;
        const pend = `e2e.c.pending.${tag}@example.com`;
        const lateInv = await action(M, "inviteMember", [null, form({ email: late, role: "manager" })], cAdmin2);
        await action(M, "inviteMember", [null, form({ email: pend, role: "referee" })], cAdmin2);
        const a2 = await memberOf(adm2Email);
        // An open invite to the admin's own address, from before they joined.
        await db().from("organization_invites").insert({ organization_id: C, email: adm2Email, role: "manager", token_hash: randomBytes(32).toString("hex"), expires_at: new Date(Date.now() + 86_400_000).toISOString(), created_by: null, created_by_role: "owner" });
        await action(M, "changeMemberRole", [null, form({ member_id: a2?.id ?? "", role: "referee" })], cOwner);
        const lateR = await inviteSignIn(tokenIn(lateInv.text), late);
        const lateMember = await memberOf(late);
        check(!lateMember && !lateR.token, "an invite whose sender has since lost the right to give that role is void", [lateR.landed, lateMember]);
        await action(M, "removeMember", [null, form({ member_id: a2?.id ?? "" })], cOwner);
        const { data: left } = await db().from("organization_invites").select("email, revoked_at").eq("organization_id", C).in("email", [pend, adm2Email]).is("accepted_at", null);
        check(((left ?? []) as { revoked_at: string | null }[]).length >= 2 && ((left ?? []) as { revoked_at: string | null }[]).every((i) => i.revoked_at), "removing a member withdraws the open invites they sent and any to their own address", left);
      }

      section("the last owner, under concurrency (L1)");
      {
        const a3 = await memberOf(adm3Email);
        const promote = await action(M, "changeMemberRole", [null, form({ member_id: a3?.id ?? "", role: "owner" })], cOwner);
        check(actionOk(promote), "C gets a second owner", promote.text.slice(0, 120));
        const ownerRow = await memberOf(applicant);
        // Each owner demotes the other at the same moment: one must stay.
        await Promise.all([
          action(M, "changeMemberRole", [null, form({ member_id: a3?.id ?? "", role: "admin" })], cOwner),
          action(M, "changeMemberRole", [null, form({ member_id: ownerRow?.id ?? "", role: "admin" })], cAdmin3),
        ]);
        const { count: owners } = await db().from("organization_members").select("id", { count: "exact", head: true }).eq("organization_id", C).eq("role", "owner").eq("status", "active");
        check((owners ?? 0) >= 1, "two owners demoting each other at once leave one owner (the trigger locks the organisation)", owners);
        // Put things back: the applicant is C's owner for the rest of the run.
        const now1 = await memberOf(applicant);
        if (now1?.role !== "owner") await db().from("organization_members").update({ role: "owner" }).eq("id", now1?.id ?? "");
        await db().from("organization_members").update({ role: "admin" }).eq("id", a3?.id ?? "");
      }

      section("an invite planted in someone's browser: no silent join, no lockout (M4)");
      {
        const victim = `e2e.a.admin.${tag}@example.com`;
        // Forced join: C's owner invites A's admin into C and plants the link in their browser.
        const forcedInv = await action(M, "inviteMember", [null, form({ email: victim, role: "manager" })], cOwner);
        const planted = await plantInvite(tokenIn(forcedInv.text) ?? "");
        const signIn = await googleIn(victim, planted);
        const { count: joined } = await db().from("organization_members").select("id", { count: "exact", head: true }).eq("organization_id", C).eq("auth_user_id", aAdminUser.id);
        check(joined === 0, "signing in with a planted invite to another organisation joins nothing by itself", joined);
        check(Boolean(signIn.jar.get("mb_session")?.startsWith("mbs1.")), "…and the person's own sign-in goes through (their staff cookie is set)", signIn.landed);
        const asked = await http("GET", "/invite", { Cookie: cookieHeader(signIn.jar) });
        check(signIn.landed.endsWith("/invite") && asked.text.includes(`Join ${cName} as manager?`), "…they are asked \"Join … as manager?\" instead", signIn.landed);
        const no = await answer("decline", signIn.jar);
        const { count: joined2 } = await db().from("organization_members").select("id", { count: "exact", head: true }).eq("organization_id", C).eq("auth_user_id", aAdminUser.id);
        check(no.landed.endsWith("/admin/tournaments") && !no.jar.has("mb_invite") && !no.jar.has("mb_invite_ok") && joined2 === 0, "\"Not now\": the browser forgets the invite, nothing joined, on to their own console", no.landed);
        // Lockout: an invite for someone else's address, planted in the victim's browser.
        const other = await action(M, "inviteMember", [null, form({ email: `e2e.c.attacker.${tag}@example.com`, role: "referee" })], cOwner);
        const planted2 = await plantInvite(tokenIn(other.text) ?? "");
        const signIn2 = await googleIn(victim, planted2);
        check(signIn2.landed.endsWith("/admin/tournaments") && Boolean(signIn2.jar.get("mb_session")?.startsWith("mbs1.")), "a planted invite for another address never blocks the person's sign-in", signIn2.landed);
        check(!signIn2.jar.has("mb_invite"), "…and the browser forgets it at once", [...signIn2.jar.keys()]);
        // The confirm cookie is bound to one invite: it cannot accept another.
        const own = await action(M, "inviteMember", [null, form({ email: `e2e.c.confirm.${tag}@example.com`, role: "referee" })], cOwner);
        const ownSigned = await googleIn(`e2e.c.confirm.${tag}@example.com`, await plantInvite(tokenIn(own.text) ?? ""));
        const swapped = new Map(ownSigned.jar);
        const third = await action(M, "inviteMember", [null, form({ email: `e2e.c.third.${tag}@example.com`, role: "referee" })], cOwner);
        for (const [k, v] of await plantInvite(tokenIn(third.text) ?? "")) swapped.set(k, v);
        const swapAccept = await answer("accept", swapped);
        const { count: thirdIn } = await db().from("organization_members").select("id", { count: "exact", head: true }).eq("organization_id", C).eq("invited_email", `e2e.c.third.${tag}@example.com`);
        const { count: confirmIn } = await db().from("organization_members").select("id", { count: "exact", head: true }).eq("organization_id", C).eq("invited_email", `e2e.c.confirm.${tag}@example.com`);
        check(ownSigned.landed.endsWith("/invite") && thirdIn === 0 && confirmIn === 0 && /error=invalid/.test(swapAccept.landed), "a \"Join … ?\" answer only ever accepts the invite it was asked about", swapAccept.landed);
      }

      section("organisations cannot reach each other's members, invites, codes or profile");
      const { data: bMem } = await db().from("organization_members").select("id").eq("organization_id", B).eq("status", "active").limit(1).single();
      const B_MEMBER = (bMem as { id: string }).id;
      const bInv = await action(M, "inviteMember", [null, form({ email: `e2e.b.pending.${tag}@example.com`, role: "referee" })], cookie(bOwnerWeb.token ?? ""));
      check(actionOk(bInv), "B's owner invites someone into B");
      const { data: bInvRow } = await db().from("organization_invites").select("id").eq("organization_id", B).single();
      const B_INVITE = (bInvRow as { id: string }).id;
      const bBefore = JSON.stringify([(await db().from("organization_members").select("role, status").eq("organization_id", B)).data, (await db().from("organization_invites").select("revoked_at").eq("organization_id", B)).data, (await db().from("organizations").select("name, about, colors").eq("id", B).single()).data]);
      for (const who of [aAdmin, { label: "C owner", headers: cOwner }]) {
        const r1 = await action(M, "changeMemberRole", [null, form({ member_id: B_MEMBER, role: "referee" })], who.headers);
        const r2 = await action(M, "removeMember", [null, form({ member_id: B_MEMBER })], who.headers);
        const r3 = await action(M, "revokeInvite", [null, form({ invite_id: B_INVITE })], who.headers);
        const r4 = await action("src/app/admin/org/profile/actions.ts", "updateOrgProfile", [null, form({ organization_id: B, name: "PWNED", about: "PWNED" })], who.headers);
        const r5 = await action("src/app/admin/org/codes/actions.ts", "revokeEventCode", [form({ code_id: CB })], who.headers);
        check([r1, r2, r3, r4, r5].every(actionRefused) && ![r1, r2, r3, r4].some((r) => r.text.includes(`e2e.b.`)), `${who.label}: B's members, invites, profile and codes are refused`, [r1, r2, r3, r4, r5].map((r) => r.status));
      }
      const into = await action(M, "inviteMember", [null, form({ email: `e2e.into.${tag}@example.com`, role: "manager", organization_id: B })], aAdmin.headers);
      const { data: intoRows } = await db().from("organization_invites").select("organization_id").eq("email", `e2e.into.${tag}@example.com`);
      check(actionOk(into) && ((intoRows ?? []) as { organization_id: string }[]).every((r) => r.organization_id === A), "an invite with B's id posted lands in the caller's own organisation, never B", intoRows);
      const bAfter = JSON.stringify([(await db().from("organization_members").select("role, status").eq("organization_id", B)).data, (await db().from("organization_invites").select("revoked_at").eq("organization_id", B)).data, (await db().from("organizations").select("name, about, colors").eq("id", B).single()).data]);
      check(bBefore === bAfter, "none of B's members, invites or profile changed");
      const aMembers = await http("GET", "/admin/org/members", aAdmin.headers);
      const aProfile = await http("GET", "/admin/org/profile", aAdmin.headers);
      check(aMembers.status === 200 && !aMembers.text.includes(`e2e.b.`) && !aMembers.text.includes(applicant), "A's members page shows none of B's or C's people");
      check(aProfile.status === 200 && aProfile.text.includes(`E2E Club A ${tag}`) && !aProfile.text.includes(`E2E Club B ${tag}`), "A's profile page is A's");
      for (const who of [aReferee, aOperator]) {
        const r = await http("GET", "/admin/org/members", who.headers);
        check(r.status !== 200 || !r.text.includes("invite-form"), `${who.label}: no members page`, r.status);
      }

      section("profile and branding feed the app");
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
      const prof = form({ organization_id: C, name: cName, about: `About C ${tag}`, city: "Giza", country: "Egypt", color_primary: "#123456", color_accent: "#ABCDEF", venue_0_name: "C Courts", venue_0_address: "1 Pyramid Rd", venue_0_courts: "6" });
      prof.append("logo", new File([png], "logo.png", { type: "image/png" }));
      const saved = await action("src/app/admin/org/profile/actions.ts", "updateOrgProfile", [null, prof], cOwner);
      /** The whole profile as saved above, with `extra` changed (a save sends every field). */
      const profForm = (extra: Record<string, string>) => form({ organization_id: C, name: cName, about: `About C ${tag}`, city: "Giza", country: "Egypt", color_primary: "#123456", color_accent: "#ABCDEF", venue_0_name: "C Courts", venue_0_address: "1 Pyramid Rd", venue_0_courts: "6", ...extra });
      const { data: cRow } = await db().from("organizations").select("colors, logo_url, venues").eq("id", C).single();
      const cr = cRow as { colors: { primary: string; accent: string }; logo_url: string | null; venues: { name: string }[] };
      check(actionOk(saved) && cr.colors.primary === "#123456" && cr.colors.accent === "#abcdef" && Boolean(cr.logo_url) && cr.venues[0]?.name === "C Courts", "C's owner saves its profile, colours, logo and venues", saved.text.slice(0, 160));
      const fake = form({ organization_id: C, name: cName });
      fake.append("logo", new File([Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")], "logo.png", { type: "image/png" }));
      const fakeR = await action("src/app/admin/org/profile/actions.ts", "updateOrgProfile", [null, fake], cOwner);
      const { data: cRow2 } = await db().from("organizations").select("logo_url").eq("id", C).single();
      check(/"ok":false/.test(fakeR.text) && (cRow2 as { logo_url: string }).logo_url === cr.logo_url, "a file that is not the image it claims is refused (server-side check)", fakeR.text.slice(0, 160));
      {
        // L4: the stored type and extension come from the bytes, and huge canvases are refused.
        const misnamed = profForm({});
        misnamed.append("logo", new File([png], "logo.html", { type: "image/jpeg" }));
        const mR = await action("src/app/admin/org/profile/actions.ts", "updateOrgProfile", [null, misnamed], cOwner);
        const { data: mRow } = await db().from("organizations").select("logo_url").eq("id", C).single();
        const mUrl = (mRow as { logo_url: string }).logo_url;
        check(actionOk(mR) && /\.png$/.test(mUrl) && mUrl !== cr.logo_url, "a PNG uploaded as \"logo.html\" (declared JPEG) is stored as .png", mUrl);
        const bomb = Buffer.alloc(33);
        png.copy(bomb, 0, 0, 16);
        bomb.writeUInt32BE(30000, 16);
        bomb.writeUInt32BE(30000, 20);
        const huge = profForm({});
        huge.append("logo", new File([bomb], "logo.png", { type: "image/png" }));
        const hR = await action("src/app/admin/org/profile/actions.ts", "updateOrgProfile", [null, huge], cOwner);
        const { data: hRow } = await db().from("organizations").select("logo_url").eq("id", C).single();
        check(/"ok":false/.test(hR.text) && (hRow as { logo_url: string }).logo_url === mUrl, "a logo declaring a 30000 × 30000 canvas is refused", hR.text.slice(0, 160));
      }
      const bill = await action(P, "saveBilling", [null, form({ org_id: C, tier: "pro", commission_pct: "7.5", subscription_status: "trial" })], cOwner);
      const billP = await action(P, "saveBilling", [null, form({ org_id: C, tier: "standard", commission_pct: "5", subscription_status: "trial" })], platform);
      const { data: planRow } = await db().from("organizations").select("plan").eq("id", C).single();
      const plan = (planRow as { plan: { tier: string; commission_pct: number; subscription_status: string } }).plan;
      check(actionRefused(bill) && actionOk(billP) && plan.tier === "standard" && plan.commission_pct === 5, "billing fields are the platform admins' only", plan);

      const { data: ct } = await db()
        .from("tournaments")
        .insert({ name: `C Open ${tag}`, slug: `e2e-c-open-${tag}`, organization_id: C, status: "active", public_access_enabled: true, is_demo: false })
        .select("id, slug")
        .single();
      created.tournaments.push((ct as { id: string }).id);
      const pub = await http("GET", `/api/mobile/v1/orgs/${C_SLUG}`);
      const pj = pub.json as { organization?: Record<string, unknown>; tournaments?: { upcoming: { slug: string; organization?: { slug: string } }[] }; comingSoon?: string[] } | null;
      check(pub.status === 200 && pj?.organization?.name === cName && (pj.organization.colors as { primary: string }).primary === "#123456", "the public organisation API shows the profile", pub.status);
      check(Boolean(pj?.tournaments?.upcoming.some((t) => t.slug === (ct as { slug: string }).slug && t.organization?.slug === C_SLUG)), "…its public tournaments, linked back to it");
      check(JSON.stringify(pj?.comingSoon) === JSON.stringify(["leagues", "boards"]) && !/"leagues":\[|"boards":\[/.test(pub.text), "leagues and boards are marked as coming, with no sample data");
      const privateBits = [applicant, mgrEmail, admEmail, "contact_email", "application", "commission", "subscription", "\"plan\"", "top_board", "invited_email", "token_hash", "code_hash", "Cee Applicant", "\"applied\"", "\"approved\""];
      const leaks = privateBits.filter((x) => pub.text.includes(x));
      check(leaks.length === 0, "…and no private field: no member emails, application, plan or billing, codes", leaks);
      check(JSON.stringify(Object.keys(pj?.organization ?? {}).sort()) === JSON.stringify(["about", "city", "colors", "country", "logoUrl", "name", "slug", "venues"]), "…the organisation object has exactly the public fields", Object.keys(pj?.organization ?? {}));
      let bundleOk = false;
      let bundleSeen: unknown = null;
      for (let i = 0; i < 9 && !bundleOk; i++) {
        const b = await http("GET", `/api/mobile/v1/t/${(ct as { slug: string }).slug}/bundle`);
        const t = (b.json as { tournament?: { organization?: { slug: string }; skin?: { seedA: string | null; logoUrl: string | null } } } | null)?.tournament;
        bundleSeen = t ? { org: t.organization, skin: t.skin } : b.status;
        bundleOk = t?.organization?.slug === C_SLUG && t.skin?.seedA === "#123456" && Boolean(t.skin?.logoUrl);
        if (!bundleOk) await new Promise((r) => setTimeout(r, 5000));
      }
      check(bundleOk, "a tournament without its own skin takes C's colours and logo in the app, and links to C", bundleSeen);

      const follow = await http("POST", "/api/mobile/v1/me/follows", bearer(aAdminUser.accessToken), { add: [{ kind: "organization", key: C_SLUG, tournamentId: null }] });
      const follows = (follow.json?.follows ?? []) as { kind: string; key: string }[];
      check(follow.status === 200 && follows.some((f) => f.kind === "organization" && f.key === C_SLUG), "the app follows an organisation", follow.status);
      const { data: fRow } = await db().from("follows").select("target_kind").eq("owner_id", aAdminUser.id).eq("target_key", C_SLUG);
      check(((fRow ?? []) as { target_kind: string }[])[0]?.target_kind === "organization", "…stored as target_kind 'organization' (the database allows it)");
      const unfollow = await http("POST", "/api/mobile/v1/me/follows", bearer(aAdminUser.accessToken), { remove: [{ kind: "organization", key: C_SLUG, tournamentId: null }] });
      check(!((unfollow.json?.follows ?? []) as { kind: string; key: string }[]).some((f) => f.key === C_SLUG), "…and unfollows it");
      const bogus = await http("POST", "/api/mobile/v1/me/follows", bearer(aAdminUser.accessToken), { add: [{ kind: "organisation_admin", key: C_SLUG, tournamentId: null }] });
      check(!((bogus.json?.follows ?? []) as { kind: string }[]).some((f) => f.kind === "organisation_admin"), "an unknown follow kind is ignored");
      await db().from("follows").delete().eq("owner_id", aAdminUser.id);

      section("renames wait for Move Beyond; look-alike names are refused (L3)");
      {
        const PR = "src/app/admin/org/profile/actions.ts";
        const nameNow = async (): Promise<{ name: string; pending_name: string | null }> => {
          const r = await db().from("organizations").select("name, pending_name").eq("id", C).single();
          // (A database without 0025 — a proof run against an older build — has no pending_name.)
          if (r.error) return { name: ((await db().from("organizations").select("name").eq("id", C).single()).data as { name: string }).name, pending_name: null };
          return r.data as { name: string; pending_name: string | null };
        };
        for (const [label, name] of [["Move Beyond's name", "move  BEYOND"], ["Move Score's name", "Move-Score"], ["another organisation's name (case and spaces aside)", `e2e   club a ${tag}`], ["a web address", "www.evil.example"]] as const) {
          const r = await action(PR, "updateOrgProfile", [null, profForm({ name })], cOwner);
          const n = await nameNow();
          check(/"ok":false/.test(r.text) && n.name === cName && n.pending_name === null, `a rename to ${label} is refused`, [r.text.slice(0, 120), n]);
        }
        const newName = `C Renamed ${tag}`;
        const r = await action(PR, "updateOrgProfile", [null, profForm({ name: newName })], cOwner);
        const n = await nameNow();
        const pubName = ((await http("GET", `/api/mobile/v1/orgs/${C_SLUG}?r=${tag}`)).json as { organization?: { name: string } } | null)?.organization?.name;
        check(actionOk(r) && n.name === cName && n.pending_name === newName && pubName === cName, "a rename of an approved organisation waits for a platform admin; the public name stays", [n, pubName]);
        const notYours = await action(P, "decideRename", [null, form({ org_id: C, decision: "approve" })], cOwner);
        check(actionRefused(notYours) && (await nameNow()).name === cName, "the organisation cannot approve its own rename");
        const listed = await http("GET", "/admin/platform/organizations", platform);
        check(listed.text.includes(newName), "the platform admin sees the rename waiting");
        const ok = await action(P, "decideRename", [null, form({ org_id: C, decision: "approve" })], platform);
        const after = await nameNow();
        check(actionOk(ok) && after.name === newName && after.pending_name === null, "approved, the new name applies", after);
        const { data: renAudit } = await db().from("audit_logs").select("actor_role").eq("organization_id", C).eq("action", "ORGANIZATION_RENAMED");
        check(((renAudit ?? []) as { actor_role: string }[]).every((x) => x.actor_role === "platform") && (renAudit ?? []).length === 1, "…audited as the platform's decision", renAudit);
        await db().from("organizations").update({ name: cName }).eq("id", C);
      }
      {
        // Invite email has brakes: per organisation, and per address.
        const target = `e2e.spammed.${tag}@example.com`;
        const results: boolean[] = [];
        for (let i = 0; i < 6; i++) results.push(/"ok":true/.test((await action(M, "inviteMember", [null, form({ email: target, role: "referee" })], aAdmin.headers)).text));
        check(results.slice(0, 4).every(Boolean) && !results[5], "one address cannot be sent invite after invite (a few a day at most)", results);
      }

      section("suspension and status");
      const susp = await action(P, "setOrganizationStatus", [null, form({ org_id: C, status: "suspended" })], aAdmin.headers);
      check(actionRefused(susp), "A's admin cannot suspend C");
      const suspP = await action(P, "setOrganizationStatus", [null, form({ org_id: C, status: "suspended" })], platform);
      const cOut = await http("GET", "/admin/tournaments", cOwner);
      const cPub = await http("GET", `/api/mobile/v1/orgs/${C_SLUG}?x=${tag}`);
      check(actionOk(suspP) && cOut.status === 307 && /org_suspended/.test(cOut.location), "a platform admin suspends C: its owner is out on the next request", cOut.location);
      check(cPub.status === 404, "…and its public page is gone", cPub.status);
      const back = await action(P, "setOrganizationStatus", [null, form({ org_id: C, status: "approved" })], platform);
      check(actionOk(back) && (await http("GET", "/admin/tournaments", cOwner)).status === 200, "reinstated, the same cookie works again");
      const { data: mbOrg } = await db().from("organizations").select("id").eq("slug", "move-beyond").single();
      const mbSusp = await action(P, "setOrganizationStatus", [null, form({ org_id: (mbOrg as { id: string }).id, status: "suspended" })], platform);
      check(/"ok":false/.test(mbSusp.text), "Move Beyond itself cannot be suspended");
      const created2 = await action(P, "createOrganization", [null, form({ name: `E2E Club D ${tag}`, slug: `e2e-d-${tag}`, invite_email: `e2e.d.owner.${tag}@example.com`, invite_role: "owner" })], platform);
      const { data: dRow } = await db().from("organizations").select("id, status").eq("slug", `e2e-d-${tag}`).maybeSingle();
      if (dRow) created.orgs.push((dRow as { id: string }).id);
      check(actionOk(created2) && (dRow as { status: string } | null)?.status === "approved" && Boolean(tokenIn(created2.text)), "Move Beyond creates an organisation directly and invites its first owner", created2.text.slice(0, 160));
      const createdByA = await action(P, "createOrganization", [null, form({ name: `E2E Club E ${tag}`, invite_email: `e.${tag}@example.com` })], aAdmin.headers);
      const { count: eRows } = await db().from("organizations").select("id", { count: "exact", head: true }).eq("name", `E2E Club E ${tag}`);
      check(actionRefused(createdByA) && eRows === 0, "…which nobody else can");
    } finally {
      await db().from("platform_admins").delete().eq("auth_user_id", platformUser.id);
    }

    section("staff login brakes count failures only");
    {
      const codeMany = generateEventCode();
      await db().from("organization_codes").insert({ organization_id: A, role: "referee", code_hash: hashEventCode(codeMany), label: "e2e venue" });
      const venue = { "X-Forwarded-For": `192.0.2.${(randomBytes(1)[0] % 200) + 20}` };
      const statuses: number[] = [];
      for (let i = 0; i < 45; i++) statuses.push((await http("POST", "/api/mobile/v1/staff/session", venue, { code: codeMany })).status);
      check(statuses.every((s) => s === 200), "45 referees sharing one event code on one venue Wi-Fi all sign in", statuses.filter((s) => s !== 200).length);
      // Wrong codes that start like it, from many addresses: the prefix brake still stops guessing.
      let prefixLast = 0;
      for (let i = 0; i < 40; i++) {
        const wrongCode = `${codeMany.slice(0, 4)}${generateEventCode().slice(4)}`;
        prefixLast = (await http("POST", "/api/mobile/v1/staff/session", { "X-Forwarded-For": `203.0.113.${i + 10}` }, { code: wrongCode })).status;
      }
      const afterGuess = await http("POST", "/api/mobile/v1/staff/session", { "X-Forwarded-For": "198.51.100.200" }, { code: codeMany });
      check(prefixLast === 401 && afterGuess.status === 429, "40 failed guesses at one prefix, spread over addresses, still close it", [prefixLast, afterGuess.status]);
      // M3: counted before the attempt, atomically: a simultaneous wave gets no more tries than the limit.
      const wave = { "X-Forwarded-For": `198.51.100.${(randomBytes(1)[0] % 150) + 50}` };
      const waveStatuses = await Promise.all(Array.from({ length: 60 }, () => http("POST", "/api/mobile/v1/staff/session", wave, { code: generateEventCode() }).then((r) => r.status)));
      const tried = waveStatuses.filter((x) => x === 401).length;
      check(tried <= 20 && waveStatuses.every((x) => x === 401 || x === 429), "60 simultaneous wrong codes from one address: at most 20 are tried", { tried, refused: waveStatuses.filter((x) => x === 429).length });
      const pw = { "X-Forwarded-For": `198.51.100.${(randomBytes(1)[0] % 40) + 210}` };
      const pwStatuses = await Promise.all(Array.from({ length: 15 }, (_, i) => http("POST", "/api/mobile/v1/staff/session", pw, { code: `hunter2 #${i} ${tag}!` }).then((r) => r.status)));
      const pwTried = pwStatuses.filter((x) => x === 401).length;
      check(pwTried <= 6, "anything not shaped like an event code (a shared-password guess) gets a much smaller allowance, waves included", { tried: pwTried });
    }
  } finally {
    // Clean up: children first (tournaments cascade to their rows), then the organisations.
    await db().from("audit_logs").delete().in("organization_id", created.orgs);
    await db().from("friendly_entries").delete().in("session_id", created.sessions);
    await db().from("friendly_sessions").delete().in("id", created.sessions);
    await db().from("message_deliveries").delete().in("announcement_id", created.announcements);
    await db().from("message_announcements").delete().in("organization_id", created.orgs);
    await db().from("organization_codes").delete().in("organization_id", created.orgs);
    const { data: clones } = await db().from("tournaments").select("id").in("organization_id", created.orgs);
    const all = [...new Set([...created.tournaments, ...((clones ?? []) as { id: string }[]).map((c) => c.id)])];
    await db().from("tournaments").update({ event_group_id: null }).in("id", all);
    await db().from("tournaments").delete().in("id", all);
    await db().from("event_groups").delete().in("id", created.groups);
    await db().from("seasons").delete().in("id", created.seasons);
    await db().from("organization_players").delete().in("organization_id", created.orgs);
    await db().from("friendly_ranking_snapshots").delete().in("player_profile_id", created.profiles);
    await db().from("player_profiles").delete().in("id", created.profiles);
    await db().from("organization_members").delete().in("id", created.mbMembers);
    await db().from("organization_invites").delete().eq("organization_id", MB).like("email", `%${tag}@example.com`);
    await db().from("message_deliveries").delete().like("address", `%${tag}@example.com`);
    // Members and invites go with their organisation (cascade; the last-owner trigger allows that).
    await db().from("organizations").delete().in("id", created.orgs);
    const { count } = await db().from("organizations").select("id", { count: "exact", head: true }).in("id", created.orgs);
    check(count === 0, "cleaned up");
  }
  console.log(`\n${failed === 0 ? "✅" : "❌"} organizations: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

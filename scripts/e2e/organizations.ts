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
import { join } from "path";
import { db } from "../../src/lib/supabase";
import { createFriendlySession } from "../../src/lib/friendly/ops";
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
  const created = { orgs: [] as string[], tournaments: [] as string[], profiles: [] as string[], groups: [] as string[], seasons: [] as string[], announcements: [] as string[], sessions: [] as string[] };

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
      return { id, slug: (t as { slug: string }).slug, team1: t1, team2: t2, player: (pl as { id: string }).id, match: (m as { id: string }).id };
    }
    const TA = await tournament(A, `Alpha Open ${tag}`);
    const TA2 = await tournament(A, `Alpha Second ${tag}`);
    const TB = await tournament(B, `${SECRET_B} Bravo Cup`);
    await db().from("teams").update({ nation_code: "ZQX" }).eq("id", TB.team1);

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
    const { data: codes } = await db()
      .from("organization_codes")
      .insert([
        { organization_id: B, role: "referee", code_hash: hashEventCode(codeB), label: "e2e" },
        { organization_id: A, role: "referee", code_hash: hashEventCode(codeAref), label: "e2e" },
        { organization_id: A, role: "operator", tournament_id: TA.id, code_hash: hashEventCode(codeAop), label: "e2e" },
      ])
      .select("id, organization_id, role");
    const codeRows = codes as { id: string; organization_id: string; role: string }[];
    const CB = codeRows.find((c) => c.organization_id === B)!.id;
    const CAref = codeRows.find((c) => c.organization_id === A && c.role === "referee")!.id;

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
    ];
    for (const who of everyone) {
      for (const p of pages) {
        if (who === mbShared && p === "/admin/platform/discover") continue; // Move Beyond's own platform page
        const r = await http("GET", p, who.headers);
        const refused = r.status === 404 || (r.status >= 300 && r.status < 400 && r.location.includes("/login"));
        // The page echoes its own URL; anything of B's beyond that is a leak.
        const echoed = p.split("/").reduce((t, seg) => (seg.length > 20 ? t.split(seg).join("") : t), r.text);
        check(refused && !leaked(echoed), `${who.label}: ${p} refused`, `${r.status} ${r.location}`);
      }
    }
    section("lists: only the organisation's own rows");
    const lists = ["/admin/tournaments", "/admin/announcements", "/admin/announcements/new", "/admin/friendly-sessions", "/admin/players", "/admin/seasons", "/admin/rankings", "/admin/org/codes", "/referee", "/operator"];
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
    ];
    async function bSnapshot() {
      const [t, team, pl, m, g, se, a, an, prof, op, s, e, sc, cd, codesForTB, newAnn, clones, appPosts, screens, deliveries] = await Promise.all([
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
      ]);
      const { data: ta } = await db().from("tournaments").select("event_group_id").eq("id", TA.id).maybeSingle();
      return JSON.stringify([t.data, team.data, pl.data, m.data, g.data, se.data, a.data, an.data, prof.data, op.data, s.data, e.data, sc.data, cd.data, codesForTB.data, newAnn.data, clones.data, appPosts.data, screens.data, deliveries.data, ta]);
    }
    const before = await bSnapshot();
    for (const who of everyone) {
      for (const atk of attacks) {
        const r = await action(atk.file, atk.name, atk.args(), who.headers);
        check(!actionOk(r) && !leaked(r.text), `${who.label}: ${atk.label} refused`, `${r.status} ${r.text.slice(0, 120)}`);
      }
    }
    const after = await bSnapshot();
    check(before === after, "none of B's rows changed (tournament, teams, player, match, group, season, announcements, profile, session, entries, codes, screens, deliveries)", before === after ? undefined : { before, after });
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
    await db().from("player_profiles").delete().in("id", created.profiles);
    await db().from("organization_members").delete().in("organization_id", created.orgs);
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

/**
 * The 3D venue map and navigation (migration 0039), end to end on the stand-in:
 * two events of one event group (the Junior Finals' shape: boys on Courts 1–8,
 * girls on 9–16) with a live tie on Court 7, and the organiser's venue editor.
 *
 *   1. Admin: the editor page opens; loading the sample layout and saving it as
 *      JSON (published) both work; a bad document is refused with its reason.
 *   2. Public venue API: one venue for both events' slugs, only public keys (no
 *      underlay, no survey fixes, no organisation), courts linked to both
 *      events' court rows; shared CDN caching. Unpublished → 404.
 *   3. Live lines: Court 7 carries "EGY 1–0 USA" and "6–4 3–2" with its match.
 *   4. Route API: a path along the walkways with distance, time and steps to
 *      Court 7 from a phone at the venue; from the Main Entrance (and saying so)
 *      without a location or from far away; an unknown destination is a 400.
 *      The answer is never cached.
 *   5. Survey mode: the averaged spot moves a feature (stored with its fix),
 *      a reference spot lines the plan up; the public venue still has no fix.
 *   6. Site plan: a DXF-derived vector underlay is saved and stays private.
 *   7. Another organisation's admin cannot open the editor, save, survey or
 *      change the site plan; the venue is untouched.
 *   8. The web map page renders (with the sample notice), and "Show on map" on
 *      the match page links to the court.
 *
 *   LOCALDB_PORT=54351 npm run localdb                   # another terminal
 *   npm run build && npx next start -p 3107              # env from .env.localdb
 *   npm run e2e:venue-map
 *
 * Creates and deletes its own data.
 */
import { createHash, randomBytes, randomUUID } from "crypto";
import { db } from "../../src/lib/supabase";
import { MOVE_BEYOND_SLUG } from "../../src/lib/orgs/roles";
import { localToGeo } from "../../src/lib/venue/geo";
import { sampleVenue, SAMPLE_NOTE } from "../../src/lib/venue/sample";
import { PUBLIC_VENUE_KEYS, keysOf } from "../../src/lib/venue/public";
import { parseDxf } from "../../src/lib/venue/dxf";
import type { PublicVenue, VenueLive } from "../../src/lib/venue/types";
import { assertStandIn, check, cookie, finish, fixtures, http, section, staff } from "./lib/fixtures";
import { staffToken } from "./lib/session";
import { callAction, form } from "./lib/actions";

assertStandIn("venue-map");

const SUPA = process.env.SUPABASE_URL ?? "";
const tag = randomUUID().slice(0, 6);
const f = fixtures(tag);
const made = { group: null as string | null, orgs: [] as string[] };
const ACTIONS = "src/app/admin/tournaments/[id]/venue/actions.ts";

async function standinUser(email: string): Promise<string> {
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
  return ((await t.json()) as { user: { id: string } }).user.id;
}

const okOf = (r: { status: number; text: string }) => r.status === 200 && /"ok":true/.test(r.text);
const refusedOf = (r: { status: number; text: string }) => /"ok":false/.test(r.text) || /"digest"|Not found|Not allowed/.test(r.text) || r.status >= 400;

async function venueRow() {
  const { data } = await db().from("venue_maps").select("id, organization_id, event_group_id, tournament_id, doc, underlay, published, version").eq("event_group_id", made.group!).maybeSingle();
  return data as { id: string; organization_id: string; doc: ReturnType<typeof sampleVenue>; underlay: unknown; published: boolean; version: number } | null;
}

async function main() {
  const { data: mb } = await db().from("organizations").select("id").eq("slug", MOVE_BEYOND_SLUG).single();
  const MB = (mb as { id: string }).id;
  const ADMIN = staff("admin");

  /* ---------------- two events of one group, a live tie on Court 7 ---------------- */
  const { data: g, error: ge } = await db().from("event_groups").insert({ slug: `e2e-venue-${tag}`, name: `E2E Junior Finals ${tag}`, organization_id: MB, timezone: "Africa/Cairo" }).select("id").single();
  if (ge) throw new Error(`event_groups: ${ge.message}`);
  made.group = (g as { id: string }).id;
  const BOYS = await f.tournament({ name: "Venue Boys" });
  const GIRLS = await f.tournament({ name: "Venue Girls" });
  await db()
    .from("tournaments")
    .update({ organization_id: MB, event_group_id: made.group, public_access_enabled: true, format_config: { type: "group_knockout", ties: { rubbers: ["S2", "S1", "D"] } } })
    .in("id", [BOYS, GIRLS]);
  const { data: tr } = await db().from("tournaments").select("id, slug").in("id", [BOYS, GIRLS]);
  const slugOf = new Map(((tr ?? []) as { id: string; slug: string }[]).map((t) => [t.id, t.slug]));
  const BS = slugOf.get(BOYS)!;
  const GS = slugOf.get(GIRLS)!;
  const ins = async (tid: string, from: number) => {
    const { data } = await db()
      .from("courts")
      .insert(Array.from({ length: 8 }, (_, i) => ({ tournament_id: tid, court_name: `Court ${from + i}`, court_order: i + 1 })))
      .select("id, court_name");
    return Object.fromEntries(((data ?? []) as { id: string; court_name: string }[]).map((c) => [c.court_name, c.id])) as Record<string, string>;
  };
  const bc = await ins(BOYS, 1);
  const gc = await ins(GIRLS, 9);
  const bt = (await f.teams(BOYS, ["Egypt", "Usa"])).teams;
  await db().from("teams").update({ nation_code: "EGY", iso2: "eg" }).eq("id", bt[0].id);
  await db().from("teams").update({ nation_code: "USA", iso2: "us" }).eq("id", bt[1].id);
  const { data: tie } = await db()
    .from("ties")
    .insert({ tournament_id: BOYS, team_a_id: bt[0].id, team_b_id: bt[1].id, court_id: bc["Court 7"], status: "live", rubbers_a: 1, rubbers_b: 0, tie_order: 1, scheduled_time: new Date().toISOString() })
    .select("id")
    .single();
  const TIE = (tie as { id: string }).id;
  const R2 = await f.match(BOYS, { team_a_id: bt[0].id, team_b_id: bt[1].id, court_id: bc["Court 7"], tie_id: TIE, rubber_no: 2, rubber_type: "S1", status: "live", match_order: 2, started_at: new Date().toISOString() } as never);
  await db().from("match_score_snapshots").insert({
    match_id: R2.id,
    tournament_id: BOYS,
    current_set_number: 2,
    team_a_games: 3,
    team_b_games: 2,
    team_a_sets: 1,
    team_b_sets: 0,
    team_a_point_label: "15",
    team_b_point_label: "30",
    completed_sets: [{ teamAGames: 6, teamBGames: 4 }],
    last_event_number: 40,
    snapshot_json: { servingTeam: "A" },
  });

  /* ---------------- 1. the editor ---------------- */
  section("1. Admin: the editor, the sample layout, saving JSON");
  const page = await http("GET", `/admin/tournaments/${BOYS}/venue`, ADMIN);
  check(page.status === 200 && page.text.includes('data-testid="venue-editor-page"') && page.text.includes("every event of the group"), "the editor opens for the organiser, on the event group's venue", page.status);
  const survey0 = await http("GET", `/admin/tournaments/${GIRLS}/venue/survey`, ADMIN);
  check(survey0.status === 200 && survey0.text.includes("Save the venue first"), "Survey mode asks for a venue first", survey0.status);

  const sample = await callAction(ACTIONS, "loadSampleVenueAction", [null, form({ tournament_id: BOYS })], ADMIN, { id: BOYS });
  check(okOf(sample), "Load sample layout answers ok", sample.text.slice(0, 200));
  let row = await venueRow();
  check(Boolean(row) && row!.organization_id === MB && row!.doc.courts.length === 16 && row!.doc.sample === true && row!.published === false, "one venue for the group: 16 courts, marked sample, not published yet", row && { courts: row.doc.courts.length, published: row.published });
  const hidden = await http("GET", `/api/mobile/v1/t/${BS}/venue`);
  check(hidden.status === 404, "an unpublished venue is not public", hidden.status);
  // The server keeps a public venue (or its absence) for 5 s.
  await new Promise((res) => setTimeout(res, 5_500));

  const bad = await callAction(ACTIONS, "saveVenueAction", [null, form({ tournament_id: BOYS, doc: JSON.stringify({ geo: { lat: 300, lng: 0 } }), published: "on" })], ADMIN, { id: BOYS });
  check(/"ok":false/.test(bad.text) && /lat and lng/.test(bad.text), "a bad document is refused with its reason", bad.text.slice(-200));
  const notJson = await callAction(ACTIONS, "saveVenueAction", [null, form({ tournament_id: BOYS, doc: "{" })], ADMIN, { id: BOYS });
  check(/"ok":false/.test(notJson.text) && /not valid JSON/.test(notJson.text), "not JSON is refused", notJson.text.slice(-120));

  const doc = sampleVenue();
  const save = await callAction(ACTIONS, "saveVenueAction", [null, form({ tournament_id: GIRLS, doc: JSON.stringify({ ...doc, injected: "<script>x</script>" }), published: "on" })], ADMIN, { id: GIRLS });
  check(okOf(save) && /published/.test(save.text), "saving the sample as JSON from the other event (published) works", save.text.slice(-200));
  row = await venueRow();
  check(row!.published && row!.version >= 2 && !JSON.stringify(row!.doc).includes("injected"), "the same row, published, version bumped, unknown fields dropped", { v: row!.version });

  /* ---------------- 2. public venue ---------------- */
  section("2. Public venue API: only public data, both events' courts");
  const pub = await http("GET", `/api/mobile/v1/t/${BS}/venue`);
  const venue = pub.json as unknown as PublicVenue;
  check(pub.status === 200 && /public/.test(pub.cache ?? "") && /s-maxage=60/.test(pub.cache ?? ""), "200, shared CDN caching", `${pub.status} ${pub.cache}`);
  check(venue.doc.courts.length === 16 && venue.doc.pois.length === doc.pois.length && venue.doc.walkways.edges.length === doc.walkways.edges.length, "16 courts, every POI and walkway");
  check(venue.doc.sample === true && venue.doc.note === SAMPLE_NOTE, "it says it is a sample layout", venue.doc.note);
  const keys = [...keysOf(venue)];
  const extra = keys.filter((k) => !(PUBLIC_VENUE_KEYS as readonly string[]).includes(k));
  check(extra.length === 0, "only public keys", extra);
  check(!/survey|underlay|organization|updated_by|accuracy|event_group|tournament_id|injected/.test(pub.text), "no survey fixes, underlay, organisation or private ids");
  check(venue.slugs.includes(BS) && venue.slugs.includes(GS), "both events of the group are on the map", venue.slugs);
  const c7 = venue.doc.courts.find((c) => c.name === "Court 7")!;
  const c12 = venue.doc.courts.find((c) => c.name === "Court 12")!;
  check(c7.links.length === 1 && c7.links[0].courtId === bc["Court 7"] && c7.links[0].slug === BS, "Court 7 links to the boys' Court 7 row", c7.links);
  check(c12.links[0]?.courtId === gc["Court 12"] && c12.links[0]?.slug === GS, "Court 12 links to the girls' Court 12 row", c12.links);
  check(venue.doc.courts.filter((c) => c.streamed).map((c) => c.name).join(",") === "Court 1,Court 9", "Courts 1 and 9 are streamed");
  const pubG = await http("GET", `/api/mobile/v1/t/${GS}/venue`);
  check(pubG.status === 200 && (pubG.json as unknown as PublicVenue).id === venue.id, "the girls' slug serves the same venue", pubG.status);
  const nope = await http("GET", `/api/mobile/v1/t/no-such-${tag}/venue`);
  check(nope.status === 404, "an unknown tournament is a 404", nope.status);

  /* ---------------- 3. live lines ---------------- */
  section("3. Courts carry their live match");
  const liveR = await http("GET", `/api/mobile/v1/t/${GS}/venue/live`);
  const live = liveR.json as unknown as VenueLive;
  const l7 = live.courts.find((c) => c.courtKey === c7.id);
  check(liveR.status === 200 && /s-maxage=2/.test(liveR.cache ?? ""), "the live lines are shared for 2 s", liveR.cache);
  check(l7?.live === true && l7.title === "EGY 1–0 USA" && l7.detail === "6–4 3–2" && l7.matchId === R2.id && l7.tieId === TIE && l7.slug === BS, "Court 7: EGY 1–0 USA · 6–4 3–2, live, with its match", l7);
  check(!live.courts.some((c) => c.courtKey === c12.id), "a court with nothing on has no line");
  check(!/player|phone|email|access_code/.test(liveR.text), "no player data in the live lines");

  /* ---------------- 4. routes ---------------- */
  section("4. Route API");
  const at = localToGeo(doc.geo, { x: 150, y: 74 });
  const r1 = await http("POST", `/api/mobile/v1/t/${BS}/venue/route`, {}, { to: "court:7", from: { ...at, accuracy: 6 } });
  const j1 = r1.json as { fromEntrance: boolean; distance: number; seconds: number; summary: string; points: { x: number; y: number }[]; steps: { text: string; kind: string }[]; target: { name: string } } | null;
  check(r1.status === 200 && /no-store/.test(r1.cache ?? ""), "200, never cached", `${r1.status} ${r1.cache}`);
  check(Boolean(j1) && !j1!.fromEntrance && j1!.target.name === "Court 7" && j1!.points.length >= 2 && j1!.distance > 0 && j1!.seconds > 0, "a path to Court 7 from the phone's position", j1 && { d: j1.distance, s: j1.seconds, n: j1.points.length });
  check(j1!.steps.at(-1)!.text === "You've arrived at Court 7." && j1!.steps.some((s) => /Court 7/.test(s.text)), "steps end with arriving at Court 7", j1!.steps.map((s) => s.text));
  const r2 = await http("POST", `/api/mobile/v1/t/${BS}/venue/route`, {}, { to: "poi:medical" });
  const j2 = r2.json as { fromEntrance: boolean; note: string; distance: number; steps: { text: string }[] };
  check(r2.status === 200 && j2.fromEntrance && /Main Entrance/.test(j2.note) && j2.distance > 50, "without a location: from the Main Entrance, and it says so", j2.note);
  const r3 = await http("POST", `/api/mobile/v1/t/${BS}/venue/route`, {}, { to: "court:c12", from: { lat: 30.0444, lng: 31.2357, accuracy: 5 } });
  check((r3.json as { fromEntrance: boolean; note: string })?.fromEntrance === true && /not at the venue/.test((r3.json as { note: string }).note), "from far away: from the Main Entrance", r3.json?.note);
  const r4 = await http("POST", `/api/mobile/v1/t/${BS}/venue/route`, {}, { to: "court:99" });
  check(r4.status === 400, "an unknown destination is a 400", r4.status);

  /* ---------------- 5. survey ---------------- */
  section("5. Survey mode");
  const spot = localToGeo(doc.geo, { x: 37, y: -27 });
  const s1 = await callAction(ACTIONS, "surveySpotAction", [null, form({ tournament_id: BOYS, feature: "poi:main-gate", mode: "move", lat: String(spot.lat), lng: String(spot.lng), accuracy: "3.4", samples: "11" })], ADMIN, { id: BOYS });
  check(okOf(s1) && /placed at the surveyed spot/.test(s1.text), "Save this spot moves the Main Entrance", s1.text.slice(-200));
  row = await venueRow();
  const gate = row!.doc.pois.find((p) => p.id === "main-gate")!;
  check(Math.abs(gate.point.x - 37) < 0.1 && Math.abs(gate.point.y + 27) < 0.1 && gate.survey?.accuracy === 3.4 && gate.survey?.samples === 11, "stored at the spot with its fix", gate);
  const vague = await callAction(ACTIONS, "surveySpotAction", [null, form({ tournament_id: BOYS, feature: "poi:medical", mode: "move", lat: String(spot.lat), lng: String(spot.lng), accuracy: "250", samples: "3" })], ADMIN, { id: BOYS });
  check(/"ok":false/.test(vague.text) && /too vague/.test(vague.text), "a vague fix is refused", vague.text.slice(-150));
  const truth = { ...doc.geo, lat: doc.geo.lat + 0.0003, rotationDeg: 8 };
  for (const [ref, p] of [["court:c16", doc.courts[15].center], ["poi:prayer", doc.pois.find((x) => x.id === "prayer")!.point]] as const) {
    const g2 = localToGeo(truth, p);
    const a = await callAction(ACTIONS, "surveySpotAction", [null, form({ tournament_id: BOYS, feature: ref, mode: "align", lat: String(g2.lat), lng: String(g2.lng), accuracy: "2", samples: "9" })], ADMIN, { id: BOYS });
    check(okOf(a) && /reference spot/.test(a.text), `${ref} saved as a reference spot`, a.text.slice(-200));
  }
  row = await venueRow();
  check(Math.abs(row!.doc.geo.rotationDeg - 8) < 0.5, "two reference spots line the plan up (rotation fitted)", row!.doc.geo);
  // The public copy is memoised for 5 s in the server.
  await new Promise((res) => setTimeout(res, 5_500));
  const pub2 = await http("GET", `/api/mobile/v1/t/${BS}/venue`);
  check(pub2.status === 200 && !/survey|accuracy|samples/.test(pub2.text) && (pub2.json as unknown as PublicVenue).version === row!.version, "the public venue has the new version and still no survey fixes", (pub2.json as unknown as PublicVenue)?.version);

  /* ---------------- 6. site plan ---------------- */
  section("6. Site plan (DXF) stays private");
  const dxf = ["0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", "6", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES", "0", "LINE", "8", "COURTS", "10", "0", "20", "0", "11", "36", "21", "0", "0", "CIRCLE", "8", "TREES", "10", "5", "20", "5", "40", "2", "0", "ENDSEC", "0", "EOF"].join("\n");
  const plan = parseDxf(dxf);
  const underlay = { kind: "vector", source: "dxf", fileName: "SSC FINAL LAYOUT.dxf", units: plan.units, bounds: plan.bounds, layers: plan.layers.map((l) => ({ ...l, visible: l.name !== "TREES" })), center: { x: 140, y: 70 }, rotationDeg: 3, scale: 1, opacity: 0.7 };
  const u = await callAction(ACTIONS, "saveUnderlayAction", [null, form({ tournament_id: BOYS, underlay: JSON.stringify(underlay) })], ADMIN, { id: BOYS });
  check(okOf(u), "the organiser saves an imported DXF plan as the underlay", u.text.slice(-150));
  row = await venueRow();
  const stored = row!.underlay as { kind: string; layers: { name: string; visible: boolean }[] } | null;
  check(stored?.kind === "vector" && stored.layers.length === 2 && stored.layers.find((l) => l.name === "TREES")?.visible === false, "stored with its layers (TREES hidden)", stored?.layers);
  const pub3 = await http("GET", `/api/mobile/v1/t/${BS}/venue`);
  check(!/SSC FINAL|TREES|vector/.test(pub3.text), "the site plan is not in the public venue");

  /* ---------------- 7. another organisation ---------------- */
  section("7. Another organisation's admin is refused");
  const { data: o } = await db().from("organizations").insert({ slug: `e2e-venue-x-${tag}`, name: `E2E Venue Other ${tag}`, status: "approved" }).select("id").single();
  const X = (o as { id: string }).id;
  made.orgs.push(X);
  const email = `e2e.venue.x.${tag}@example.com`;
  const userId = await standinUser(email);
  await db().from("organization_members").insert({ organization_id: X, auth_user_id: userId, invited_email: email, role: "admin", status: "active" });
  const XADMIN = cookie(staffToken({ kind: "member", userId, orgId: X, role: "admin" }));
  const before = await venueRow();
  const xPage = await http("GET", `/admin/tournaments/${BOYS}/venue`, XADMIN);
  check(xPage.status === 404 || (xPage.status === 200 && !xPage.text.includes('data-testid="venue-editor-page"')), "the editor is a 404 for them", xPage.status);
  const xSurveyPage = await http("GET", `/admin/tournaments/${BOYS}/venue/survey`, XADMIN);
  check(!xSurveyPage.text.includes('data-testid="venue-survey"'), "so is Survey mode", xSurveyPage.status);
  const xSave = await callAction(ACTIONS, "saveVenueAction", [null, form({ tournament_id: BOYS, doc: JSON.stringify({ ...doc, name: "Hijacked" }), published: "on" })], XADMIN, { id: BOYS });
  check(refusedOf(xSave) && !okOf(xSave), "saving is refused", xSave.text.slice(0, 160));
  const xSample = await callAction(ACTIONS, "loadSampleVenueAction", [null, form({ tournament_id: GIRLS })], XADMIN, { id: GIRLS });
  check(refusedOf(xSample) && !okOf(xSample), "loading the sample is refused", xSample.text.slice(0, 160));
  const xSurvey = await callAction(ACTIONS, "surveySpotAction", [null, form({ tournament_id: BOYS, feature: "poi:main-gate", mode: "move", lat: "30.1", lng: "31.3", accuracy: "3", samples: "5" })], XADMIN, { id: BOYS });
  check(refusedOf(xSurvey) && !okOf(xSurvey), "surveying is refused", xSurvey.text.slice(0, 160));
  const xPlan = await callAction(ACTIONS, "saveUnderlayAction", [null, form({ tournament_id: BOYS, underlay: "" })], XADMIN, { id: BOYS });
  check(refusedOf(xPlan) && !okOf(xPlan), "removing the site plan is refused", xPlan.text.slice(0, 160));
  const after = await venueRow();
  check(after!.version === before!.version && after!.doc.name === before!.doc.name && after!.underlay !== null, "the venue is untouched", { before: before!.version, after: after!.version });
  // Their own venue for our tournament cannot be made directly either (the trigger keeps the organisation).
  const { error: trig } = await db().from("venue_maps").insert({ organization_id: X, tournament_id: BOYS, doc: {} });
  check(Boolean(trig), "the database refuses a venue of another organisation's tournament", trig?.message);

  /* ---------------- 8. web pages ---------------- */
  section("8. The web map page and Show on map");
  const map = await http("GET", `/t/${BS}/map?court=${bc["Court 7"]}`);
  check(map.status === 200 && map.text.includes('data-testid="venue-map"') && map.text.includes(SAMPLE_NOTE), "the map page renders with the sample notice", map.status);
  const embed = await http("GET", `/t/${GS}/map?embed=app&theme=dark&focus=court:c9`);
  check(embed.status === 200 && embed.text.includes("vm-embed") && !embed.text.includes("← Back"), "the app's embedded page has no web header", embed.status);
  const mp = await http("GET", `/t/${BS}/match/${R2.id}`);
  check(mp.status === 200 && mp.text.includes(`/t/${BS}/map?court=${bc["Court 7"]}`), "the match page links to its court on the map", mp.status);
  await db().from("venue_maps").update({ published: false }).eq("event_group_id", made.group);
  await new Promise((res) => setTimeout(res, 5_500));
  const gone = await http("GET", `/t/${BS}/map`);
  check(gone.status === 404, "unpublished: the map page is a 404", gone.status);
}

main()
  .catch((e) => {
    console.error(e);
    check(false, "the script ran to the end", String(e));
  })
  .finally(async () => {
    if (made.group) {
      await db().from("venue_maps").delete().eq("event_group_id", made.group);
      await db().from("audit_logs").delete().in("tournament_id", f.created.tournaments);
    }
    await db().from("venue_maps").delete().in("organization_id", made.orgs);
    await db().from("organization_members").delete().in("organization_id", made.orgs);
    await db().from("audit_logs").delete().in("organization_id", made.orgs);
    await db().from("organizations").delete().in("id", made.orgs);
    const ok = await f.cleanup();
    if (made.group) await db().from("event_groups").delete().eq("id", made.group);
    const { count } = await db().from("venue_maps").select("id", { count: "exact", head: true }).eq("event_group_id", made.group ?? randomUUID());
    check(ok && (count ?? 0) === 0, "cleaned up");
    finish("venue-map");
  });

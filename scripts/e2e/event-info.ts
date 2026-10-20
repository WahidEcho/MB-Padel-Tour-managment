/**
 * Event info for fans, end to end on the stand-in: two events of one event
 * group (the Junior Finals' shape) sharing one info page.
 *
 *   1. Admin: the Event info tab opens on either event and says it is the
 *      group's; a draft is saved (stored once, on the group's first tournament,
 *      in branding_config.eventInfo) and is not public.
 *   2. Bad input is refused with its reasons (http link, closing before
 *      opening, a phone that is not one); nothing is written.
 *   3. Published: GET /api/mobile/v1/t/<slug>/info answers for both events'
 *      slugs with the same cleaned content (markup stripped), only the known
 *      keys, directions links, shared CDN caching. The bundle never carries the
 *      stored info.
 *   4. A save based on an older version is refused (compare-and-set).
 *   5. Another organisation's admin cannot open the tab or save; the info is
 *      untouched.
 *   6. The web page /t/<slug>/info renders and the public nav links to it;
 *      unpublished, the API and the page are 404.
 *
 *   LOCALDB_PORT=54334 npm run localdb                   # another terminal
 *   npm run build && npx next start -p 3084              # env from .env.localdb (SUPABASE_URL on :54334)
 *   BASE_URL=http://localhost:3084 SUPABASE_URL=http://localhost:54334 npm run e2e:event-info
 *
 * Creates and deletes its own data.
 */
import { createHash, randomBytes, randomUUID } from "crypto";
import { db } from "../../src/lib/supabase";
import { MOVE_BEYOND_SLUG } from "../../src/lib/orgs/roles";
import type { PublicEventInfo } from "../../src/lib/eventInfo/types";
import { assertStandIn, check, cookie, finish, fixtures, http, section, sleep, staff } from "./lib/fixtures";
import { staffToken } from "./lib/session";
import { callAction, form } from "./lib/actions";

assertStandIn("event-info");

const SUPA = process.env.SUPABASE_URL ?? "";
const tag = randomUUID().slice(0, 6);
const f = fixtures(tag);
const made = { group: null as string | null, orgs: [] as string[] };
const ACTIONS = "src/app/admin/tournaments/[id]/event-info/actions.ts";

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

const EXPECTED_KEYS = ["city", "contacts", "directions", "endsOn", "entry", "eventName", "faqs", "food", "hours", "intro", "links", "map", "parking", "slug", "startsOn", "timezone", "updatedAt", "venueName"];

/** The info as stored, on whichever of the two tournaments holds it. */
async function stored(ids: string[]): Promise<{ holder: string | null; info: Record<string, unknown> | null; holders: number }> {
  const { data } = await db().from("tournaments").select("id, branding_config").in("id", ids);
  const rows = ((data ?? []) as { id: string; branding_config: { eventInfo?: Record<string, unknown> } | null }[]).filter((r) => r.branding_config?.eventInfo);
  return { holder: rows[0]?.id ?? null, info: rows[0]?.branding_config?.eventInfo ?? null, holders: rows.length };
}

function fields(o: Record<string, string>, published: boolean) {
  return form({ hours_rows: "7", faq_rows: "6", ...o, ...(published ? { published: "on" } : {}) });
}

async function main() {
  const { data: mb } = await db().from("organizations").select("id").eq("slug", MOVE_BEYOND_SLUG).single();
  const MB = (mb as { id: string }).id;
  const ADMIN = staff("admin");

  const { data: g, error: ge } = await db()
    .from("event_groups")
    .insert({ slug: `e2e-info-${tag}`, name: `E2E Junior Finals ${tag}`, organization_id: MB, timezone: "Africa/Cairo", venue_name: "Smash Sporting Club", city: "Cairo", starts_on: "2026-11-02", ends_on: "2026-11-08" })
    .select("id")
    .single();
  if (ge) throw new Error(`event_groups: ${ge.message}`);
  made.group = (g as { id: string }).id;
  const BOYS = await f.tournament({ name: "Info Boys" });
  const GIRLS = await f.tournament({ name: "Info Girls" });
  await db().from("tournaments").update({ organization_id: MB, event_group_id: made.group, public_access_enabled: true }).in("id", [BOYS, GIRLS]);
  const { data: tr } = await db().from("tournaments").select("id, slug").in("id", [BOYS, GIRLS]);
  const slugOf = new Map(((tr ?? []) as { id: string; slug: string }[]).map((t) => [t.id, t.slug]));
  const BS = slugOf.get(BOYS)!;
  const GS = slugOf.get(GIRLS)!;

  /* ---------------- 1. the tab and a draft ---------------- */
  section("1. Admin: the Event info tab, a draft");
  const page = await http("GET", `/admin/tournaments/${GIRLS}/event-info`, ADMIN);
  check(page.status === 200 && page.text.includes('data-testid="event-info-page"') && page.text.includes("every event of the group"), "the tab opens on the girls' event, as the group's info", page.status);
  check(page.text.includes('name="hours_date_0"') && page.text.includes("2026-11-02") && page.text.includes("2026-11-08"), "one hours row per day of the event (2–8 Nov)");
  check(page.text.includes('placeholder="e.g. Smash Sporting Club, 104 Airport Rd') && !page.text.includes('value="Smash Sporting Club'), "the Junior Finals address is only a placeholder");
  const draft = await callAction(ACTIONS, "saveEventInfoAction", [null, fields({ tournament_id: GIRLS, based_on: "", intro: "Draft welcome", admission: "free" }, false)], ADMIN, { id: GIRLS });
  check(okOf(draft), "a draft saves", draft.text.slice(-200));
  let s = await stored([BOYS, GIRLS]);
  check(s.holders === 1 && s.info?.published === false && s.info?.intro === "Draft welcome", "stored once for the group, as a draft", s);
  const holder = s.holder!;
  const hidden = await http("GET", `/api/mobile/v1/t/${BS}/info`);
  check(hidden.status === 404, "a draft is not public", hidden.status);

  /* ---------------- 2. refused input ---------------- */
  section("2. Bad input is refused with its reasons");
  const before = s.info!.updatedAt as string;
  const bad = await callAction(
    ACTIONS,
    "saveEventInfoAction",
    [null, fields({ tournament_id: BOYS, based_on: before, tickets_url: "http://tickets.example.com", hours_date_0: "2026-11-02", hours_opens_0: "21:00", hours_closes_0: "09:00", contact_label_0: "Desk", contact_phone_0: "12" }, true)],
    ADMIN,
    { id: BOYS },
  );
  check(/"ok":false/.test(bad.text) && /https/.test(bad.text) && /must be after opening/.test(bad.text) && /not a phone number/.test(bad.text), "refused, naming the link, the hours and the phone", bad.text.slice(-300));
  s = await stored([BOYS, GIRLS]);
  check(s.info?.updatedAt === before && s.info?.published === false, "nothing written");
  const empty = await callAction(ACTIONS, "saveEventInfoAction", [null, fields({ tournament_id: BOYS, based_on: before }, true)], ADMIN, { id: BOYS });
  check(/"ok":false/.test(empty.text) && /before publishing/.test(empty.text), "an empty page cannot be published", empty.text.slice(-160));

  /* ---------------- 3. published ---------------- */
  section("3. Published: one cleaned info for both events");
  const full = {
    tournament_id: BOYS,
    based_on: before,
    intro: "Welcome <script>alert(1)</script>fans",
    admission: "free",
    allowed: "Water bottles\n- Hats",
    not_allowed: "Drones",
    kids: "With an adult",
    photography: "No flash",
    hours_date_0: "2026-11-02",
    hours_opens_0: "09:00",
    hours_closes_0: "21:00",
    hours_date_1: "2026-11-03",
    hours_closed_1: "on",
    hours_note_1: "Rest day",
    address: "104 Airport Rd",
    landmark: "Test landmark",
    drop_off: "Main gate",
    lat: "30.1",
    lng: "31.4",
    google_maps_url: "https://maps.app.goo.gl/e2e",
    parking: "Test parking",
    food: "Test food",
    contact_label_0: "Tournament desk",
    contact_phone_0: "01001234567",
    contact_whatsapp_0: "on",
    faq_q_0: "Is it free?",
    faq_a_0: "Test answer",
  };
  const pub = await callAction(ACTIONS, "saveEventInfoAction", [null, fields(full, true)], ADMIN, { id: BOYS });
  check(okOf(pub), "published", pub.text.slice(-200));
  s = await stored([BOYS, GIRLS]);
  check(s.holder === holder && s.holders === 1 && s.info?.published === true, "still one copy, on the same tournament");
  // The server keeps a public answer (or its absence) for 5 s.
  await sleep(5_500);
  const a = await http("GET", `/api/mobile/v1/t/${BS}/info`);
  const b = await http("GET", `/api/mobile/v1/t/${GS}/info`);
  const ia = a.json as unknown as PublicEventInfo;
  const ib = b.json as unknown as PublicEventInfo;
  check(a.status === 200 && b.status === 200, "public for both events", [a.status, b.status]);
  check(ia.intro === "Welcome alert(1)fans" && !a.text.includes("<script"), "markup stripped", ia.intro);
  check(JSON.stringify(Object.keys(ia).sort()) === JSON.stringify(EXPECTED_KEYS), "only the known keys", Object.keys(ia));
  check(!/"published"|organization|branding/.test(a.text), "no bookkeeping or organisation fields");
  check(ia.eventName === `E2E Junior Finals ${tag}` && ia.startsOn === "2026-11-02" && ia.endsOn === "2026-11-08" && ia.timezone === "Africa/Cairo", "the group's name, dates and zone", { n: ia.eventName, s: ia.startsOn });
  check(ia.slug === BS && ib.slug === GS && ia.updatedAt === ib.updatedAt && ia.faqs[0]?.q === ib.faqs[0]?.q, "the same info under each slug");
  check(ia.entry.allowed.join("|") === "Water bottles|Hats" && ia.hours.length === 2 && ia.hours[1].closed && ia.contacts[0]?.phone === "+201001234567" && ia.contacts[0].whatsapp, "content cleaned (list bullets, a closed day, E.164)", ia.contacts);
  check(ia.links.google === "https://maps.app.goo.gl/e2e" && ia.links.apple === "https://maps.apple.com/?daddr=30.1%2C31.4&q=104%20Airport%20Rd", "directions links: share link, coordinates", ia.links);
  check(ia.map === null, "no published venue map: no map places");
  check(/public/.test(a.cache ?? "") && /s-maxage=60/.test(a.cache ?? ""), "shared CDN caching", a.cache);
  const bundle = await http("GET", `/api/mobile/v1/t/${BS}/bundle`);
  check(bundle.status === 200 && !bundle.text.includes("eventInfo") && !bundle.text.includes("Test parking"), "the bundle does not carry the stored info", bundle.status);

  /* ---------------- 4. compare-and-set ---------------- */
  section("4. A save based on an older version is refused");
  const stale = await callAction(ACTIONS, "saveEventInfoAction", [null, fields({ ...full, based_on: before, intro: "Overwrite" }, true)], ADMIN, { id: GIRLS });
  check(/"ok":false/.test(stale.text) && /Reload/.test(stale.text), "refused as stale", stale.text.slice(-200));
  s = await stored([BOYS, GIRLS]);
  check(s.info?.intro === "Welcome alert(1)fans", "the newer save is kept");

  /* ---------------- 5. another organisation ---------------- */
  section("5. Another organisation's admin is refused");
  const { data: o } = await db().from("organizations").insert({ slug: `e2e-info-x-${tag}`, name: `E2E Info Other ${tag}`, status: "approved" }).select("id").single();
  const X = (o as { id: string }).id;
  made.orgs.push(X);
  const email = `e2e.info.x.${tag}@example.com`;
  const userId = await standinUser(email);
  await db().from("organization_members").insert({ organization_id: X, auth_user_id: userId, invited_email: email, role: "admin", status: "active" });
  const XADMIN = cookie(staffToken({ kind: "member", userId, orgId: X, role: "admin" }));
  const xPage = await http("GET", `/admin/tournaments/${BOYS}/event-info`, XADMIN);
  check(xPage.status === 404 || (xPage.status === 200 && !xPage.text.includes('data-testid="event-info-page"')), "the tab is a 404 for them", xPage.status);
  const current = s.info!.updatedAt as string;
  const xSave = await callAction(ACTIONS, "saveEventInfoAction", [null, fields({ ...full, based_on: current, intro: "Hijacked" }, true)], XADMIN, { id: BOYS });
  check(refusedOf(xSave) && !okOf(xSave), "saving is refused", xSave.text.slice(0, 160));
  const xSave2 = await callAction(ACTIONS, "saveEventInfoAction", [null, fields({ ...full, tournament_id: GIRLS, based_on: current, intro: "Hijacked" }, false)], XADMIN, { id: GIRLS });
  check(refusedOf(xSave2) && !okOf(xSave2), "through the other event too", xSave2.text.slice(0, 160));
  s = await stored([BOYS, GIRLS]);
  check(s.info?.updatedAt === current && s.info?.intro === "Welcome alert(1)fans" && s.info?.published === true, "the info is untouched");

  /* ---------------- 6. web ---------------- */
  section("6. The web page and the nav");
  const web = await http("GET", `/t/${GS}/info`);
  check(web.status === 200 && web.text.includes('data-testid="event-info"') && web.text.includes("Test parking") && web.text.includes("Is it free?"), "the web page renders the info", web.status);
  check(web.text.includes("wa.me/201001234567") && web.text.includes("tel:+201001234567"), "with Call and WhatsApp");
  const overview = await http("GET", `/t/${BS}`);
  check(overview.status === 200 && overview.text.includes(`/t/${BS}/info`), "the public nav links to Info", overview.status);
  const unpub = await callAction(ACTIONS, "saveEventInfoAction", [null, fields({ ...full, based_on: current }, false)], ADMIN, { id: BOYS });
  check(okOf(unpub), "unpublished", unpub.text.slice(-160));
  await sleep(5_500);
  const gone = await http("GET", `/api/mobile/v1/t/${BS}/info`);
  const goneWeb = await http("GET", `/t/${BS}/info`);
  check(gone.status === 404 && goneWeb.status === 404, "unpublished: the API and the page are 404", [gone.status, goneWeb.status]);
}

main()
  .catch((e) => {
    console.error(e);
    check(false, "the script ran to the end", String(e));
  })
  .finally(async () => {
    await db().from("audit_logs").delete().in("tournament_id", f.created.tournaments);
    await db().from("organization_members").delete().in("organization_id", made.orgs);
    await db().from("audit_logs").delete().in("organization_id", made.orgs);
    await db().from("organizations").delete().in("id", made.orgs);
    const ok = await f.cleanup();
    if (made.group) await db().from("event_groups").delete().eq("id", made.group);
    check(ok, "cleaned up");
    finish("event-info");
  });

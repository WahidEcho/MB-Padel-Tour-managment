/**
 * Notices on screen and the order of play by day (stand-in only): the organiser
 * sets "play delayed" with a message and a resume time on Admin → In the app
 * (bad input refused with a reason, another organisation cannot), the live feed
 * carries `playStatus` additively (every 1.0.1 field still there), a push to the
 * followers is queued once when asked for, the public site shows the banner under
 * its header and the ties page lists the order of play by day and court, and
 * "Normal" takes the banner down.
 *
 *   LOCALDB_PORT=54331 npm run localdb                   # terminal 1
 *   npm run build && SUPABASE_URL=http://localhost:54331 PUBLIC_SITE_URL=http://localhost:3081 PUSH_DRY_RUN=1 \
 *     node --env-file=.env.localdb node_modules/next/dist/bin/next start -p 3081      # terminal 2
 *   SUPABASE_URL=http://localhost:54331 BASE_URL=http://localhost:3081 npm run e2e:play-status   # terminal 3
 */
import { randomUUID } from "crypto";
import { db } from "../../src/lib/supabase";
import { MOVE_BEYOND_SLUG } from "../../src/lib/orgs/roles";
import type { Match } from "../../src/lib/types";
import { actionOk, callAction, form } from "./lib/actions";
import { appUser, assertStandIn, check, cookie, finish, fixtures, http, section, staff, type Who } from "./lib/fixtures";
import { staffToken } from "./lib/session";

const ADMIN = staff("admin");
const ACTIONS = "src/app/admin/tournaments/[id]/app/actions.ts";
const refused = (r: { status: number; text: string }) => !actionOk(r) || /"ok":false/.test(r.text);

async function main() {
  assertStandIn("play-status");
  for (const prefix of ["staff-", "devices"]) await db().from("request_counters").delete().like("bucket_key", `${prefix}%`);
  const tag = randomUUID().slice(0, 6);
  const f = fixtures(tag);
  const { data: mb } = await db().from("organizations").select("id").eq("slug", MOVE_BEYOND_SLUG).single();
  const MB = (mb as { id: string }).id;
  let T = "";

  try {
    T = await f.tournament({ name: "Play Status", sport: "tennis" });
    await db().from("tournaments").update({ public_access_enabled: true, organization_id: MB, format_config: { ties: {} }, timezone: "Africa/Cairo" }).eq("id", T);
    const { data: trow } = await db().from("tournaments").select("slug").eq("id", T).single();
    const slug = (trow as { slug: string }).slug;
    const [c1, c2] = await f.courts(T, 2);
    await db().from("courts").update({ court_name: `Centre ${tag}`, court_order: 1 }).eq("id", c1);
    await db().from("courts").update({ court_name: `Court Two ${tag}`, court_order: 2 }).eq("id", c2);
    const nat = await f.teams(T, ["Egypt", "Spain", "Japan", "Usa"], 2);
    const [EGY, ESP, JPN, USA] = nat.teams;
    // Two days of ties on two courts (10:00 and 14:00 Cairo), one "to be scheduled".
    const day1 = "2026-11-02";
    const day2 = "2026-11-03";
    const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+02:00`).toISOString();
    const ties = [
      { tie_order: 1, court_id: c1, scheduled_time: at(day1, "10:00"), team_a_id: EGY.id, team_b_id: ESP.id },
      { tie_order: 2, court_id: c2, scheduled_time: at(day1, "10:00"), team_a_id: JPN.id, team_b_id: USA.id },
      { tie_order: 3, court_id: c1, scheduled_time: at(day2, "14:00"), team_a_id: EGY.id, team_b_id: JPN.id },
      { tie_order: 4, court_id: null, scheduled_time: null, team_a_id: null, team_b_id: null, round_name: `Play-off ${tag}` },
    ];
    for (const t of ties) await db().from("ties").insert({ tournament_id: T, group_id: nat.groupId, round_no: 1, status: "scheduled", ...t });
    const { data: tieRows } = await db().from("ties").select("id").eq("tournament_id", T).order("tie_order");
    await f.match(T, { team_a_id: EGY.id, team_b_id: ESP.id, court_id: c1, group_id: nat.groupId, match_order: 1, tie_id: (tieRows as { id: string }[])[0].id, rubber_no: 1, rubber_type: "S2" } as Partial<Match> & { team_a_id: string; team_b_id: string });

    section("Admin → In the app → Play status");
    const save = (who: Who, o: Record<string, string>, id = T) => callAction(ACTIONS, "savePlayStatus", [null, form({ tournament_id: id, ...o })], who, { id });
    const page = await http("GET", `/admin/tournaments/${T}/app`, ADMIN);
    check(page.status === 200 && page.text.includes("Play status") && page.text.includes("Normal · no banner"), "The In the app tab has the Play status control, set to normal", page.status);
    const badKind = await save(ADMIN, { kind: "storm" });
    check(refused(badKind) && /Pick a play status/.test(badKind.text), "An unknown status is refused with the reason", badKind.text.slice(0, 160));
    const badTime = await save(ADMIN, { kind: "delayed", resume_at: "3pm" });
    check(refused(badTime) && /HH:MM/.test(badTime.text), "A resume time that is not HH:MM is refused");
    const long = await save(ADMIN, { kind: "delayed", message: "x".repeat(201) });
    check(refused(long), "A message over 200 characters is refused");
    const ok = await save(ADMIN, { kind: "delayed", message: "Rain. Courts are being dried.", resume_at: "15:30", push: "on" });
    check(actionOk(ok) && /"ok":true/.test(ok.text) && /followers/.test(ok.text), "Play delayed is saved with a push to followers", ok.text.slice(0, 200));
    const { data: stored } = await db().from("tournaments").select("branding_config").eq("id", T).single();
    const ps = (stored as { branding_config: { playStatus?: { kind: string; message?: string; resumeAt?: string; updatedAt: string } } }).branding_config.playStatus;
    check(ps?.kind === "delayed" && ps.message === "Rain. Courts are being dried." && Boolean(ps.resumeAt), "Stored in branding_config.playStatus (no migration)", ps);
    const { data: pushes } = await db().from("notification_events").select("kind, payload, dedupe_key").like("dedupe_key", `play_status:${T}:%`);
    const push = ((pushes ?? []) as { kind: string; payload: { title: string; body: string; category: string; targets: { kind: string; key: string }[] } }[])[0];
    check(
      (pushes ?? []).length === 1 && push.kind === "announcement" && push.payload.category === "major" && /Play delayed/.test(push.payload.title) && /15:30/.test(push.payload.body) && push.payload.targets.some((x) => x.kind === "tournament" && x.key === T),
      "One major alert is queued for the tournament's followers, with the resume time",
      push?.payload,
    );
    const { count: audits } = await db().from("audit_logs").select("id", { count: "exact", head: true }).eq("tournament_id", T).eq("action", "PLAY_STATUS_SET");
    check((audits ?? 0) === 1, "The change is audited", audits);

    section("The live feed and the public site");
    const live = await http("GET", `/api/mobile/v1/t/${slug}/live`);
    const lj = JSON.parse(live.text) as Record<string, unknown> & { playStatus?: { kind: string; message: string | null; resumeAt: string | null } | null };
    check(live.status === 200 && lj.playStatus?.kind === "delayed" && lj.playStatus.message === "Rain. Courts are being dried." && typeof lj.playStatus.resumeAt === "string", "The live feed carries playStatus", lj.playStatus);
    check(["generatedAt", "tournamentId", "bundleVersion", "ties", "matches", "announcements"].every((k) => k in lj), "Every field 1.0.1 reads is still on the live feed");
    const web = await http("GET", `/t/${slug}/ties`);
    check(web.status === 200 && web.text.includes("play-notice") && web.text.includes("Play delayed") && web.text.includes("Rain. Courts are being dried.") && web.text.includes("15:30"), "The public ties page shows the delay banner under the header", web.status);
    check(web.text.includes("order-of-play") && web.text.includes(`day-${day1}`) && web.text.includes(`day-${day2}`) && web.text.includes("day-tbc"), "The ties page has a day picker with both days and the to-be-scheduled bucket");
    check(web.text.includes(`Centre ${tag}`) && web.text.includes("Not before 10:00"), "The first day is grouped by court with Not before times");

    section("Another organisation cannot set it");
    const { data: o } = await db().from("organizations").insert({ slug: `e2e-ps-x-${tag}`, name: `E2E Play Status Other ${tag}`, status: "approved" }).select("id").single();
    const X = (o as { id: string }).id;
    f.created.orgs.push(X);
    const xUser = await appUser(`e2e.ps.x.${tag}@example.com`);
    await db().from("organization_members").insert({ organization_id: X, auth_user_id: xUser.userId, invited_email: `e2e.ps.x.${tag}@example.com`, role: "admin", status: "active" });
    const XADMIN = cookie(staffToken({ kind: "member", userId: xUser.userId, orgId: X, role: "admin" }));
    const xSave = await save(XADMIN, { kind: "suspended", message: "Not yours" });
    const { data: still } = await db().from("tournaments").select("branding_config").eq("id", T).single();
    check(!actionOk(xSave) && (still as { branding_config: { playStatus?: { kind: string } } }).branding_config.playStatus?.kind === "delayed", "Another organisation's admin is refused and nothing changes", xSave.status);

    section("Back to normal");
    const normal = await save(ADMIN, { kind: "normal", message: "ignored", push: "on" });
    check(actionOk(normal) && /banner is off/.test(normal.text), "Normal is saved", normal.text.slice(0, 160));
    const live2 = JSON.parse((await http("GET", `/api/mobile/v1/t/${slug}/live`)).text) as { playStatus?: unknown };
    check(live2.playStatus === null, "The live feed's playStatus is null again", live2.playStatus);
    const { count: pushCount } = await db().from("notification_events").select("id", { count: "exact", head: true }).like("dedupe_key", `play_status:${T}:%`);
    check(pushCount === 1, "Normal never pushes", pushCount);
    if (process.env.KEEP === "1") {
      await save(ADMIN, { kind: "suspended", message: "Lightning in the area. Players off court.", resume_at: "16:00" });
      console.log(`\nKEEP=1: tournament ${T}\n  web  /t/${slug}/ties\n  app  movescore://t/${slug}`);
      return;
    }
  } finally {
    if (process.env.KEEP !== "1") await cleanup();
  }
  finish("play-status");

  async function cleanup() {
    if (T) await db().from("notification_events").delete().like("dedupe_key", `play_status:${T}:%`);
    const clean = await f.cleanup();
    check(clean, "Every test row is removed");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

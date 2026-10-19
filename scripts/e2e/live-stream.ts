/**
 * Live stream end to end (stand-in only): the organiser sets a YouTube live video
 * for one court on the Live stream tab (bad links refused with a reason, the
 * court must be the tournament's own, another organisation cannot), the public
 * bundle / live / courts / match payloads carry `liveVideo` only for that court
 * and only on its match in play, the broadcast overlay for the court renders
 * (transparent, the right score, ACE, the sponsor loop) from public data only,
 * and the web match page embeds the player.
 *
 *   LOCALDB_PORT=54341 npm run localdb                   # terminal 1
 *   npm run build && (set -a; . ./.env.localdb; set +a; PUBLIC_SITE_URL=http://localhost:3097 \
 *     PUSH_DRY_RUN=1 MESSAGING_DRY_RUN=1 npx next start -p 3097)   # terminal 2
 *   npm run e2e:live-stream                              # terminal 3
 *
 * KEEP=1 leaves the rows in place (for screenshots) and prints the URLs.
 */
import { randomUUID } from "crypto";
import { db } from "../../src/lib/supabase";
import * as C from "../../src/lib/scoring/console";
import type { ScoreState, TeamKey } from "../../src/lib/scoring/engine";
import { scoringConfigForMatch } from "../../src/lib/scoring/rules";
import { MOVE_BEYOND_SLUG } from "../../src/lib/orgs/roles";
import { DEFAULT_TENNIS_SCORING_CONFIG, type Match, type ScoringConfig, type Tournament } from "../../src/lib/types";
import { actionOk, callAction, form } from "./lib/actions";
import { appUser, assertStandIn, check, cookie, finish, fixtures, http, section, sleep, staff, type Who } from "./lib/fixtures";
import { staffToken } from "./lib/session";

const ADMIN = staff("admin");
const ACTIONS = "src/app/admin/tournaments/[id]/live-stream/actions.ts";
const VIDEO = "Ab3_dE-fGh9";
const VIDEO_OFF = "Zz9_yX-wVu8";
const refused = (r: { status: number; text: string }) => !actionOk(r) || /"ok":false/.test(r.text);

/** A scoring console as the clients run it: events built with the shared console, sent in order. */
class Scorer {
  state: ScoreState | null = null;
  n = 0;
  constructor(private m: Match, private who: Who, private config: ScoringConfig) {}
  private ev(e: C.ConsoleEvent | null) {
    if (!e) throw new Error("the console refused the step");
    this.n++;
    const ids: Record<TeamKey, string | null> = { A: this.m.team_a_id, B: this.m.team_b_id };
    const out = {
      client_event_id: randomUUID(),
      event_number: this.n,
      event_type: e.eventType,
      team_id: e.team ? ids[e.team] : null,
      previous_state: this.state,
      new_state: e.next,
      payload: e.winner ? { ...(e.payload ?? {}), winner_team_id: ids[e.winner] } : e.payload,
      created_at_client: new Date().toISOString(),
    };
    this.state = e.next;
    return out;
  }
  async run(...steps: ((s: ScoreState | null) => C.ConsoleEvent | null)[]) {
    const events = steps.map((f) => this.ev(f(this.state)));
    return http("POST", `/api/matches/${this.m.id}/events`, this.who, { deviceId: `e2e-stream-${this.m.id.slice(0, 6)}`, events });
  }
  opts(): C.ConsoleOptions {
    return { config: this.config, confirmFirst: false, online: true, tennis: true, doubles: false };
  }
}

async function main() {
  assertStandIn("live-stream");
  for (const prefix of ["staff-", "devices"]) await db().from("request_counters").delete().like("bucket_key", `${prefix}%`);
  const tag = randomUUID().slice(0, 6);
  const f = fixtures(tag);
  const keep = process.env.KEEP === "1";
  const { data: mb } = await db().from("organizations").select("id").eq("slug", MOVE_BEYOND_SLUG).single();
  const MB = (mb as { id: string }).id;

  try {
    /* ---------------- fixtures ---------------- */
    const T = await f.tournament({ name: "Live Stream", sport: "tennis", scoring: DEFAULT_TENNIS_SCORING_CONFIG as unknown as Record<string, unknown> });
    await db()
      .from("tournaments")
      .update({
        public_access_enabled: true,
        organization_id: MB,
        format_config: { ties: {} },
        timezone: "Africa/Cairo",
        branding_config: {
          mainSponsor: { name: "Main Partner", logoUrl: `https://cdn.e2e.example/${tag}/main.png`, accentHex: "#00aeef", aspect: 2.5 },
          sponsors: [
            { name: "Sponsor One", logoUrl: `https://cdn.e2e.example/${tag}/one.png`, aspect: 1 },
            { name: "Sponsor Two", logoUrl: `https://cdn.e2e.example/${tag}/two.png`, aspect: 3 },
          ],
        },
      })
      .eq("id", T);
    const { data: trow } = await db().from("tournaments").select("*").eq("id", T).single();
    const tournament = trow as Tournament;
    const slug = tournament.slug;
    const [c13, c14] = await f.courts(T, 2);
    await db().from("courts").update({ court_name: "Court 13 (boys)", court_order: 13 }).eq("id", c13);
    await db().from("courts").update({ court_name: "Court 14 (girls)", court_order: 14 }).eq("id", c14);
    const nat = await f.teams(T, ["Egypt", "Usa", "Spain", "Japan"], 2);
    const [EGY, USA, ESP, JPN] = nat.teams;
    const codes = [
      [EGY, "EGY", "eg", "Egypt"],
      [USA, "USA", "us", "United States"],
      [ESP, "ESP", "es", "Spain"],
      [JPN, "JPN", "jp", "Japan"],
    ] as const;
    for (const [t, code, iso2, name] of codes) {
      await db().from("teams").update({ team_name: `${name} ${tag}`, nation_code: code, iso2, phone: "+201000000000", notes: "team private note" }).eq("id", t.id);
    }
    // Private player fields that must never reach a public surface.
    await db().from("players").update({ full_name: "Omar Hassan", phone: "+201234567890", email: `omar-${tag}@example.com` }).eq("id", EGY.players[0]);
    await db().from("players").update({ full_name: "Karim Fathy" }).eq("id", EGY.players[1]);
    await db().from("players").update({ full_name: "Jack Smith", email: `jack-${tag}@example.com` }).eq("id", USA.players[0]);
    await db().from("players").update({ full_name: "Leo Brown" }).eq("id", USA.players[1]);
    const { data: codeRows } = await db().from("players").select("access_code").eq("tournament_id", T);
    const accessCodes = ((codeRows ?? []) as { access_code: string | null }[]).map((r) => r.access_code ?? "").filter(Boolean);

    const { data: tie1 } = await db().from("ties").insert({ tournament_id: T, group_id: nat.groupId, round_no: 1, round_name: "Final", tie_order: 1, court_id: c13, team_a_id: EGY.id, team_b_id: USA.id, status: "live", rubbers_a: 1 }).select("id").single();
    const { data: tie2 } = await db().from("ties").insert({ tournament_id: T, group_id: nat.groupId, round_no: 1, round_name: "Final", tie_order: 1, court_id: c14, team_a_id: ESP.id, team_b_id: JPN.id, status: "live" }).select("id").single();
    const tie = (id: string, no: number, type: string) => ({ tie_id: id, rubber_no: no, rubber_type: type });
    const r1 = await f.match(T, { team_a_id: EGY.id, team_b_id: USA.id, court_id: c13, group_id: nat.groupId, match_order: 1, ...tie(tie1!.id, 1, "S2"), team_a_player_ids: [EGY.players[1]], team_b_player_ids: [USA.players[1]], status: "completed", winner_team_id: EGY.id, started_at: new Date(Date.now() - 7_200_000).toISOString(), ended_at: new Date(Date.now() - 3_600_000).toISOString() } as Partial<Match> & { team_a_id: string; team_b_id: string });
    const r2 = await f.match(T, { team_a_id: EGY.id, team_b_id: USA.id, court_id: c13, group_id: nat.groupId, match_order: 2, ...tie(tie1!.id, 2, "S1"), team_a_player_ids: [EGY.players[0]], team_b_player_ids: [USA.players[0]] } as Partial<Match> & { team_a_id: string; team_b_id: string });
    const r3 = await f.match(T, { team_a_id: EGY.id, team_b_id: USA.id, court_id: c13, group_id: nat.groupId, match_order: 3, ...tie(tie1!.id, 3, "D"), team_a_player_ids: EGY.players, team_b_player_ids: USA.players } as Partial<Match> & { team_a_id: string; team_b_id: string });
    const g1 = await f.match(T, { team_a_id: ESP.id, team_b_id: JPN.id, court_id: c14, group_id: nat.groupId, match_order: 4, ...tie(tie2!.id, 1, "S2"), team_a_player_ids: [ESP.players[0]], team_b_player_ids: [JPN.players[0]] } as Partial<Match> & { team_a_id: string; team_b_id: string });

    /* ---------------- play ---------------- */
    section("Two rubbers in play: S1 on Court 13, S2 on Court 14");
    const config = scoringConfigForMatch(tournament, r2);
    const boys = new Scorer(r2, ADMIN, config);
    const play = await boys.run(
      () => C.startMatch("A"),
      (s) => C.point(s!, "A", boys.opts()),
      (s) => C.point(s!, "A", boys.opts()),
      (s) => C.point(s!, "B", boys.opts()),
    );
    check(play.status === 200, "Court 13's rubber starts and three points are scored (30–15)", play.text.slice(0, 300));
    const girls = new Scorer(g1, ADMIN, scoringConfigForMatch(tournament, g1));
    const playG = await girls.run(() => C.startMatch("A"), (s) => C.point(s!, "B", girls.opts()));
    check(playG.status === 200, "Court 14's rubber starts too", playG.text.slice(0, 300));

    /* ---------------- admin ---------------- */
    section("Admin → Live stream: one court's YouTube live video");
    const page = await http("GET", `/admin/tournaments/${T}/live-stream`, ADMIN);
    check(page.status === 200 && page.text.includes("Court 13 (boys)") && page.text.includes(`/t/${slug}/overlay/${c13}`) && page.text.includes("Stream delay"), "The Live stream tab lists every court with its OBS overlay URL and the stream delay note", page.status);
    const save = (who: Who, o: Record<string, string>) => callAction(ACTIONS, "saveLiveVideo", [null, form({ tournament_id: T, intent: "save", ...o })], who, { id: T });
    const bad = await save(ADMIN, { court_id: c13, youtube_url: "https://www.youtube.com/@MoveBeyond/live", on: "on" });
    check(refused(bad) && /channel/.test(bad.text), "A channel's live page is refused with the reason (it names no video)", bad.text.slice(0, 200));
    const notYt = await save(ADMIN, { court_id: c13, youtube_url: "https://vimeo.com/1234", on: "on" });
    check(refused(notYt), "A link that is not YouTube is refused");
    const badDelay = await save(ADMIN, { court_id: c13, youtube_url: `https://youtu.be/${VIDEO}`, on: "on", delay_seconds: "500" });
    check(refused(badDelay), "A delay outside 0–120 s is refused");
    const ok = await save(ADMIN, { court_id: c13, youtube_url: `https://www.youtube.com/live/${VIDEO}?si=share`, on: "on", delay_seconds: "8" });
    check(actionOk(ok) && /"ok":true/.test(ok.text), "Court 13's live URL is saved and switched on", ok.text.slice(0, 200));
    const off = await save(ADMIN, { court_id: c14, youtube_url: `https://youtu.be/${VIDEO_OFF}` });
    check(actionOk(off) && /"ok":true/.test(off.text), "Court 14's video is saved but left off");
    const { data: after } = await db().from("tournaments").select("branding_config").eq("id", T).single();
    const stored = (after as { branding_config: { liveVideo?: { courts?: Record<string, { youtubeId: string; on: boolean; delaySeconds?: number }> }; sponsors?: unknown[] } }).branding_config;
    check(stored.liveVideo?.courts?.[c13]?.youtubeId === VIDEO && stored.liveVideo.courts[c13].on === true && stored.liveVideo.courts[c13].delaySeconds === 8, "Only the video id is stored, with the switch and the delay", stored.liveVideo);
    check(stored.liveVideo?.courts?.[c14]?.on === false && Array.isArray(stored.sponsors) && stored.sponsors.length === 2, "Court 14 is stored off; the sponsors are untouched by the save", stored.liveVideo?.courts?.[c14]);
    const title = await callAction(ACTIONS, "saveOverlayTitle", [null, form({ tournament_id: T, overlay_title: "Davis Cup Juniors" })], ADMIN, { id: T });
    check(actionOk(title) && /"ok":true/.test(title.text), "The overlay title is saved");
    const { count: audits } = await db().from("audit_logs").select("id", { count: "exact", head: true }).eq("tournament_id", T).eq("action", "LIVE_VIDEO_EDITED");
    check((audits ?? 0) >= 2, "Each save is audited", audits);

    section("Another organisation cannot set this tournament's streams");
    const { data: o } = await db().from("organizations").insert({ slug: `e2e-stream-x-${tag}`, name: `E2E Stream Other ${tag}`, status: "approved" }).select("id").single();
    const X = (o as { id: string }).id;
    f.created.orgs.push(X);
    const xUser = await appUser(`e2e.stream.x.${tag}@example.com`);
    await db().from("organization_members").insert({ organization_id: X, auth_user_id: xUser.userId, invited_email: `e2e.stream.x.${tag}@example.com`, role: "admin", status: "active" });
    const XADMIN = cookie(staffToken({ kind: "member", userId: xUser.userId, orgId: X, role: "admin" }));
    const xSave = await save(XADMIN, { court_id: c13, youtube_url: `https://youtu.be/${VIDEO_OFF}`, on: "on" });
    const xPage = await http("GET", `/admin/tournaments/${T}/live-stream`, XADMIN);
    // A tournament of their own, and this tournament's court posted with it.
    const XT = await f.tournament({ name: "Stream Other", sport: "tennis" });
    await db().from("tournaments").update({ organization_id: X }).eq("id", XT);
    const xCross = await callAction(ACTIONS, "saveLiveVideo", [null, form({ tournament_id: XT, intent: "save", court_id: c13, youtube_url: `https://youtu.be/${VIDEO_OFF}`, on: "on" })], XADMIN, { id: XT });
    const { data: still } = await db().from("tournaments").select("branding_config").eq("id", T).single();
    const stillCourts = (still as { branding_config: { liveVideo?: { courts?: Record<string, { youtubeId: string; on: boolean }> } } }).branding_config.liveVideo?.courts ?? {};
    const { data: xRow } = await db().from("tournaments").select("branding_config").eq("id", XT).single();
    check(refused(xSave) && xPage.status !== 200, "Another organisation's admin is refused on this tournament's tab and action", { action: xSave.status, page: xPage.status });
    check(refused(xCross) && !JSON.stringify((xRow as { branding_config: unknown }).branding_config ?? {}).includes(c13), "…and cannot set this tournament's court from their own tournament", xCross.status);
    check(stillCourts[c13]?.youtubeId === VIDEO && stillCourts[c14]?.youtubeId === VIDEO_OFF && stillCourts[c14]?.on === false, "This tournament's streams are unchanged", stillCourts);

    await sleep(1_700); // the public reads are memoised

    /* ---------------- public payloads ---------------- */
    section("Public payloads: liveVideo only for Court 13's match in play");
    type V = { youtubeId: string; court: string; courtId: string; delaySeconds?: number };
    const bundle = await http("GET", `/api/mobile/v1/t/${slug}/bundle`);
    const bc = (bundle.json?.courts ?? []) as { id: string; liveVideo?: V }[];
    check(bundle.status === 200 && bc.find((c) => c.id === c13)?.liveVideo?.youtubeId === VIDEO && !bc.find((c) => c.id === c14)?.liveVideo, "The bundle's Court 13 carries its video; Court 14 (off) none", bc.map((c) => [c.id === c13 ? "13" : "14", c.liveVideo?.youtubeId ?? null]));
    check(JSON.stringify(bc.find((c) => c.id === c13)?.liveVideo) === JSON.stringify({ youtubeId: VIDEO, court: "Court 13 (boys)", courtId: c13, delaySeconds: 8 }), "liveVideo is { youtubeId, court, courtId, delaySeconds }", bc.find((c) => c.id === c13)?.liveVideo);
    const live = await http("GET", `/api/mobile/v1/t/${slug}/live`);
    const lm = (live.json?.matches ?? []) as { id: string; status: string; liveVideo?: V }[];
    const withVideo = lm.filter((m) => m.liveVideo).map((m) => m.id);
    check(live.status === 200 && JSON.stringify(withVideo) === JSON.stringify([r2.id]), "The live feed puts liveVideo on Court 13's live rubber only (not the finished S2, the waiting doubles or Court 14)", { withVideo, r2: r2.id });
    const detail = await http("GET", `/api/mobile/v1/matches/${r2.id}`);
    const detailG = await http("GET", `/api/mobile/v1/matches/${g1.id}`);
    const detail3 = await http("GET", `/api/mobile/v1/matches/${r3.id}`);
    check((detail.json?.match as { liveVideo?: V } | undefined)?.liveVideo?.youtubeId === VIDEO && !(detailG.json?.match as { liveVideo?: V } | undefined)?.liveVideo && !(detail3.json?.match as { liveVideo?: V } | undefined)?.liveVideo, "The match page payload has it for the live rubber only");
    const hero = await http("GET", "/api/mobile/v1/courts/live?demo=1");
    type HE = { tournament: { id: string }; courts: { id: string; liveVideo?: V }[]; matches: { id: string; liveVideo?: V }[] };
    const ev = ((hero.json?.events ?? []) as HE[]).find((e) => e.tournament.id === T);
    check(hero.status === 200 && Boolean(ev), "The live courts hero carries the event", ((hero.json?.events ?? []) as HE[]).length);
    check(Boolean(ev && ev.courts.find((c) => c.id === c13)?.liveVideo?.youtubeId === VIDEO && !ev.courts.find((c) => c.id === c14)?.liveVideo), "The hero's Court 13 has its video, Court 14 none");
    check(JSON.stringify(ev?.matches.filter((m) => m.liveVideo).map((m) => m.id)) === JSON.stringify([r2.id]), "…and only its match in play carries it", ev?.matches.map((m) => [m.id.slice(0, 6), Boolean(m.liveVideo)]));
    const all = JSON.stringify([bundle.json, live.json, detail.json, detailG.json, hero.json]);
    check(!all.includes(VIDEO_OFF), "The switched-off court's video id is in no public payload");

    /* ---------------- overlay ---------------- */
    section("The broadcast overlay for Court 13");
    const ov = await http("GET", `/t/${slug}/overlay/${c13}`);
    const html = ov.text;
    check(ov.status === 200 && html.includes('data-testid="broadcast-overlay"'), "The overlay page renders (200)", ov.status);
    check(/html,body\{background:transparent!important/.test(html) && !/bc-stage-host/.test(html), "Its background is transparent (no stage backdrop)");
    check(html.includes('data-state="live"') && html.includes("Davis Cup Juniors") && html.includes("EGY 1–0 USA") && /S1/.test(html), "The header strip: title · EGY 1–0 USA · S1", html.match(/data-testid="overlay-header"[^]*?<\/div>/)?.[0]?.replace(/<[^>]+>/g, "").slice(0, 120));
    const names = [...html.matchAll(/data-testid="overlay-names"[^>]*>([^]*?)<\/div>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").replace(/<!-- -->/g, ""));
    const points = [...html.matchAll(/data-testid="overlay-points"[^>]*>([^]*?)<\/div>/g)].map((m) => m[1].replace(/<[^>]+>/g, ""));
    check(JSON.stringify(names) === JSON.stringify(["O. Hassan", "J. Smith"]) && JSON.stringify(points) === JSON.stringify(["30", "15"]), "The rows: O. Hassan 30, J. Smith 15", { names, points });
    check(html.includes('data-testid="overlay-serving"') && html.includes("/flags/eg.svg") && html.includes("/flags/us.svg"), "The serving ball and both flags are drawn");
    check(html.includes('data-testid="overlay-sponsors"') && [`${tag}/main.png`, `${tag}/one.png`, `${tag}/two.png`].every((u) => html.includes(u)), "The sponsor loop carries every sponsor, main partner included");
    const secrets = ["+201000000000", "+201234567890", "team private note", `omar-${tag}@example.com`, `jack-${tag}@example.com`, VIDEO_OFF, ...accessCodes];
    const leaked = secrets.filter((s) => html.includes(s));
    check(leaked.length === 0, "No phone, email, note, access code or switched-off video in the overlay page", leaked);
    check(!/"(phone|email|access_code|notes)":/.test(html), "No private field name in its serialised props");
    const bugOnly = await http("GET", `/t/${slug}/overlay/court-13-boys?footer=0`);
    check(bugOnly.status === 200 && bugOnly.text.includes('data-court="Court 13 (boys)"') && !bugOnly.text.includes('data-testid="overlay-sponsors"'), "By court name, with ?footer=0: the bug alone");
    const footOnly = await http("GET", `/t/${slug}/overlay/${c13}?bug=0`);
    check(footOnly.status === 200 && !footOnly.text.includes('data-testid="overlay-bug"') && footOnly.text.includes('data-testid="overlay-sponsors"'), "?bug=0: the sponsor loop alone");
    const girlsOv = await http("GET", `/t/${slug}/overlay/${c14}`);
    check(girlsOv.status === 200 && girlsOv.text.includes("ESP 0–0 JPN"), "Court 14's overlay shows its own tie (the overlay is per court, not per stream switch)");
    check((await http("GET", `/t/${slug}/overlay/${randomUUID()}`)).status === 404 && (await http("GET", `/t/no-such-${tag}/overlay/${c13}`)).status === 404, "An unknown court or event is a 404");

    section("ACE on the bug, from the scoring v2 switch");
    const aced = await boys.run((s) => C.aceEvent(s!, boys.opts()));
    check(aced.status === 200, "An ace is scored on Court 13", aced.text.slice(0, 200));
    const ovAce = await http("GET", `/t/${slug}/overlay/${c13}`);
    check(ovAce.text.includes('data-testid="overlay-ace"'), "The ACE tab flashes on the bug");
    const feats = (tournament.match_day_rules as { features?: Record<string, boolean> } | null)?.features ?? {};
    await db().from("tournaments").update({ match_day_rules: { ...(tournament.match_day_rules as object), features: { ...feats, tvAces: false } } }).eq("id", T);
    const ovNoAce = await http("GET", `/t/${slug}/overlay/${c13}`);
    check(!ovNoAce.text.includes('data-testid="overlay-ace"'), "With \"Show aces on TV & app\" off, no ACE");

    /* ---------------- web ---------------- */
    section("Website: the match page plays the video inside the page");
    const web = await http("GET", `/t/${slug}/match/${r2.id}`);
    check(web.status === 200 && web.text.includes('data-testid="live-video-player"') && web.text.includes(`data-video="${VIDEO}"`) && web.text.includes(`https://www.youtube.com/watch?v=${VIDEO}`), "The live rubber's page has the player and the Open on YouTube fallback", web.status);
    check(web.text.includes('data-testid="live-video-badge"') && web.text.includes("about 8 s behind"), "…with the LIVE VIDEO badge and the delay note");
    const webG = await http("GET", `/t/${slug}/match/${g1.id}`);
    check(webG.status === 200 && !webG.text.includes('data-testid="live-video-player"') && !webG.text.includes(VIDEO_OFF), "Court 14's match page has no player (its video is off)");
    const liveList = await http("GET", `/t/${slug}/live`);
    check((liveList.text.match(/data-testid="live-video-badge"/g) ?? []).length === 1, "The live list shows one LIVE VIDEO badge (Court 13's rubber)");

    section("Switching the video off takes it off every surface");
    const offNow = await save(ADMIN, { court_id: c13, youtube_url: `https://youtu.be/${VIDEO}` });
    check(actionOk(offNow), "Court 13's video is switched off");
    await sleep(1_700);
    const live2 = await http("GET", `/api/mobile/v1/t/${slug}/live`);
    // The match page is regenerated at most every 3 s (ISR): the first look after that may still be the old copy.
    await sleep(3_200);
    await http("GET", `/t/${slug}/match/${r2.id}`);
    await sleep(800);
    const web2 = await http("GET", `/t/${slug}/match/${r2.id}`);
    check(!JSON.stringify(live2.json).includes("liveVideo"), "No liveVideo in the live feed any more");
    check(!web2.text.includes('data-testid="live-video-player"'), "No player on the match page", web2.status);

    if (keep) {
      await save(ADMIN, { court_id: c13, youtube_url: `https://youtu.be/${VIDEO}`, on: "on", delay_seconds: "8" });
      console.log(`\nKEEP=1: tournament ${T} (${slug})\n  overlay  /t/${slug}/overlay/${c13}\n  admin    /admin/tournaments/${T}/live-stream\n  match    /t/${slug}/match/${r2.id}`);
    }
    void r1;
  } finally {
    if (!keep) {
      const clean = await f.cleanup();
      check(clean, "Every test row is removed");
    }
  }
  finish("live-stream");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Tennis court TV gate: plays tie 1 of the nations demo on Court 1 through the
 * real events API, as a referee phone does, and checks the wall moves through
 * every scene on its own — line-up, walk-on (each side), live score with its
 * callouts, rubber won, tie score, doubles into a match tie-break, final tie
 * score. Saves a screenshot of each and a video of the whole run to OUT.
 *
 * It plays the demo's first tie to the end, so it only runs against the local
 * stand-in (npm run localdb, then load team-demo.sql), never the live project.
 *
 *   OUT=/tmp/tv npx tsx --env-file=.env.localdb scripts/e2e/tennis-tv.ts
 */
import { randomUUID } from "crypto";
import { createRequire } from "module";
import { db } from "../../src/lib/supabase";
import { awardPoint, initialScoreState, type ScoreState, type TeamKey } from "../../src/lib/scoring/engine";
import { scoringConfigForMatch } from "../../src/lib/scoring/rules";
import { callout } from "../../src/lib/tennis/tvScene";
import { BASE_URL, authHeaders } from "./lib/session";
import type { Match, Tournament } from "../../src/lib/types";

// Playwright is not a dependency of the app: use a global install.
const req = createRequire(`${process.env.PLAYWRIGHT_ROOT ?? "/opt/node22/lib/node_modules"}/`);
const { chromium } = req("playwright");
const OUT = process.env.OUT ?? "/tmp/tennis-tv";
if (!/localhost|127\.0\.0\.1/.test(process.env.SUPABASE_URL ?? "")) {
  console.error("tennis-tv plays the demo's first tie to the end: run it against the local stand-in only.");
  process.exit(2);
}
const SLUG = "junior-team-finals-nations-demo";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (l: string, ok: boolean, d = "") => { console.log(`${ok ? "✅" : "❌"} ${l} ${d}`); if (!ok) fails++; };

async function http(path: string, body: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, { method: "POST", headers: { ...authHeaders("referee"), "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`${path} ${res.status} ${text}`);
  return text;
}

class Referee {
  n = 0;
  deviceId = `tv-${randomUUID()}`;
  state: ScoreState = initialScoreState("A");
  constructor(public m: Match, public t: Tournament) {}
  get cfg() { return scoringConfigForMatch(this.t, this.m, null, { doubles: this.m.rubber_type === "D" }); }
  async post(type: string, prev: ScoreState | null, next: ScoreState, teamId: string | null = null, payload: unknown = null) {
    this.n++;
    await http(`/api/matches/${this.m.id}/events`, { deviceId: this.deviceId, events: [{ client_event_id: randomUUID(), event_number: this.n, event_type: type, team_id: teamId, previous_state: prev, new_state: next, payload, created_at_client: new Date().toISOString() }] });
  }
  async start() {
    await http(`/api/matches/${this.m.id}/claim`, { deviceId: this.deviceId });
    await this.post("MATCH_STARTED", null, this.state, null, { first_server: "A" });
  }
  async point(side: TeamKey) {
    const next = awardPoint(this.state, side, this.cfg);
    await this.post("POINT_AWARDED", this.state, next);
    this.state = next;
  }
  async until(pred: (s: ScoreState) => boolean, pick: () => TeamKey) {
    let guard = 0;
    while (!pred(this.state) && !this.state.matchOver) { await this.point(pick()); if (++guard > 600) throw new Error("runaway"); }
  }
  async end() {
    const wid = this.state.winner === "A" ? this.m.team_a_id! : this.m.team_b_id!;
    await this.post("MATCH_ENDED", this.state, this.state, wid, { winner_team_id: wid });
  }
}

let seed = 11;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

async function main() {
  const { data: t } = await db().from("tournaments").select("*").eq("slug", SLUG).single();
  const court1 = (await db().from("courts").select("id").eq("tournament_id", t.id).eq("court_name", "Court 1").single()).data as { id: string };
  const { data: tie } = await db().from("ties").select("*").eq("tournament_id", t.id).eq("court_id", court1.id).order("tie_order").limit(1).single();
  const rubbers = ((await db().from("matches").select("*").eq("tie_id", tie.id).order("rubber_no")).data ?? []) as Match[];
  // One photo, to prove the photo path next to the initials fallback: a drawn portrait.
  const face = (bg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400"><rect width="300" height="400" fill="${bg}"/><circle cx="150" cy="150" r="72" fill="#e8c39e"/><path d="M40 400c0-80 50-150 110-150s110 70 110 150z" fill="#1d3557"/></svg>`)}`;
  await db().from("players").update({ photo_url: face("#8fb3d9") }).eq("id", rubbers[0].team_a_player_ids![0]);

  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: OUT, size: { width: 1280, height: 720 } } });
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}/t/${SLUG}/screen/court-1-tv`);
  const main = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  await main.goto(`${BASE_URL}/t/${SLUG}/screen`);
  const scene = () => page.getAttribute("[data-scene]", "data-scene");
  const waitScene = async (kind: string, ms = 20_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if ((await scene()) === kind) return true; await sleep(250); }
    return false;
  };
  const shot = async (name: string, p = page) => { await sleep(1200); await p.screenshot({ path: `${OUT}/${name}.png` }); console.log(`   📸 ${name}`); };

  check("line-up before the tie", await waitScene("lineup"));
  await shot("01-lineup");
  await shot("01b-main-two-courts-lineup", main);

  // Rubber 1: No. 2 singles, through the walk-on, the live score and its callouts.
  const r1 = new Referee(rubbers[0], t);
  await r1.start();
  check("walk-on fires at the rubber's start", await waitScene("walkon", 8000));
  await shot("02-walkon-A");
  await sleep(6500);
  await shot("03-walkon-B");
  check("live score after the walk-on", await waitScene("live", 16000));
  const rules = r1.cfg;
  await r1.until((s) => callout(s, rules) === "Break point" && s.teamA.games + s.teamB.games > 1, () => (rand() < 0.5 ? "A" : "B"));
  await sleep(2600);
  await shot("04-live-break-point");
  await shot("04b-main-live-compact", main);
  await r1.until((s) => callout(s, rules) === "Set point", () => (rand() < 0.7 ? "A" : "B"));
  await sleep(2600);
  await shot("05-live-set-point");
  await r1.until((s) => s.matchOver, () => (rand() < 0.7 ? "A" : "B"));
  await r1.end();
  check("rubber won card when the rubber ends", await waitScene("rubber_won", 8000));
  await shot("06-rubber-won");
  check("tie score between rubbers", await waitScene("tie_score", 16000));
  await shot("07-tie-score");

  // Rubber 2 quickly, straight to its end.
  const r2 = new Referee(rubbers[1], t);
  await r2.start();
  await r2.until((s) => s.matchOver, () => (rand() < 0.35 ? "A" : "B"));
  await r2.end();
  await sleep(2000);

  // Rubber 3: the doubles, into a match tie-break.
  const r3 = new Referee(rubbers[2], t);
  await r3.start();
  check("doubles walk-on", await waitScene("walkon", 8000));
  await shot("08-walkon-doubles");
  await waitScene("live", 16000);
  await r3.until((s) => s.teamA.sets === 1, () => (rand() < 0.75 ? "A" : "B"));
  await r3.until((s) => s.teamB.sets === 1, () => (rand() < 0.25 ? "A" : "B"));
  await sleep(2600);
  check("match tie-break callout at one set all", (await page.textContent("body"))?.includes("Match tie-break") ?? false);
  await shot("09-doubles-match-tiebreak-start");
  await r3.until((s) => s.teamA.tiebreakPoints + s.teamB.tiebreakPoints >= 9, () => (rand() < 0.55 ? "A" : "B"));
  await sleep(2600);
  await shot("10-doubles-match-tiebreak");
  await r3.until((s) => s.matchOver, () => (rand() < 0.6 ? "A" : "B"));
  await r3.end();
  await waitScene("rubber_won", 8000);
  await shot("11-doubles-won");
  check("final tie score after the last rubber", await waitScene("tie_score", 16000));
  await shot("12-tie-final");
  await ctx.close();
  await browser.close();
  console.log(fails ? `\n${fails} failed` : "\nall scenes captured");
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

/**
 * Tennis voice umpire gate: rubbers of the nations demo scored by tapping the
 * real referee page with the voice on, checking that every call it speaks is the
 * one the rules ask for.
 *
 * Which pack the server holds decides the run:
 * - Only the released en-v2 (the tennis pack not rendered yet): a few points of a
 *   singles rubber. The tennis calls must be left out cleanly and sides called
 *   "server" and "receiver", with the older-pack note in the voice panel.
 * - A tone test pack as en-v3 (`--write-test-pack`, then restart the app): a full
 *   doubles rubber into a match tie-break, with nations named, deciding points,
 *   change of ends and the match tie-break called on the right points, and
 *   "Time" when the first changeover's rest runs out (a real 90-second wait).
 *
 * It plays demo rubbers, so it runs against the local stand-in only.
 *
 *   npx tsx --env-file=.env.localdb scripts/e2e/tennis-voice.ts                      # en-v2 run
 *   npx tsx --env-file=.env.localdb scripts/e2e/tennis-voice.ts --write-test-pack    # then restart the app
 *   npx tsx --env-file=.env.localdb scripts/e2e/tennis-voice.ts                      # en-v3 run
 *   npx tsx --env-file=.env.localdb scripts/e2e/tennis-voice.ts --remove-test-pack   # never commit it
 */
import { createRequire } from "module";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { db } from "../../src/lib/supabase";
import { awardPoint, endsChange, initialScoreState, pointOutcome, type ScoreState, type TeamKey } from "../../src/lib/scoring/engine";
import { scoringConfigForMatch } from "../../src/lib/scoring/rules";
import { callForTransition, supportedCall } from "../../src/lib/voice/calls";
import { encodeWav16, type PackIndex } from "../../src/lib/voice/pack";
import { PACK_SAMPLE_RATE, PHRASES, VOICE_PACK, captionFor, isTennisClip, nationClip } from "../../src/lib/voice/phrases";
import type { Match, Team, Tournament } from "../../src/lib/types";
import { BASE_URL, COOKIE_NAME, sessionToken } from "./lib/session";

const TEST_PACK_DIR = resolve(__dirname, "../../public/voice", VOICE_PACK);
const SLUG = "junior-team-finals-nations-demo";

/** A pack with one short tone per clip: every call renders, nothing is a real voice. */
function writeTestPack() {
  if (existsSync(join(TEST_PACK_DIR, "pack.json"))) throw new Error(`${TEST_PACK_DIR} already exists`);
  const ids = Object.keys(PHRASES);
  const clipLen = Math.round(PACK_SAMPLE_RATE * 0.08);
  const all = new Int16Array(ids.length * clipLen);
  const clips: PackIndex["clips"] = {};
  ids.forEach((id, i) => {
    const hz = 300 + (i % 40) * 20;
    for (let n = 0; n < clipLen; n++) all[i * clipLen + n] = Math.round(8000 * Math.sin((2 * Math.PI * hz * n) / PACK_SAMPLE_RATE));
    clips[id] = [i * clipLen, clipLen];
  });
  mkdirSync(TEST_PACK_DIR, { recursive: true });
  const index: PackIndex = {
    format: 1,
    pack: VOICE_PACK,
    sampleRate: PACK_SAMPLE_RATE,
    provider: "tones",
    voice: null,
    generatedAt: new Date().toISOString(),
    totalSamples: all.length,
    wavHash: "tones",
    clips,
  };
  writeFileSync(join(TEST_PACK_DIR, "pack.wav"), encodeWav16(all, PACK_SAMPLE_RATE));
  writeFileSync(join(TEST_PACK_DIR, "pack.json"), JSON.stringify(index));
  console.log(`wrote a tone test pack to ${TEST_PACK_DIR} — restart the app, and remove it with --remove-test-pack`);
}

const req = createRequire(`${process.env.PLAYWRIGHT_ROOT ?? "/opt/node22/lib/node_modules"}/`);
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Games as the referee taps them: "A" four straight points, "a" through a deuce (AAABBBA). */
function taps(games: string): TeamKey[] {
  return [...games].flatMap((g) => {
    const w = g.toUpperCase() as TeamKey;
    const l: TeamKey = w === "A" ? "B" : "A";
    return g === w ? [w, w, w, w] : [w, w, w, l, l, l, w];
  });
}

async function main() {
  if (process.argv.includes("--write-test-pack")) return writeTestPack();
  if (process.argv.includes("--remove-test-pack")) {
    rmSync(TEST_PACK_DIR, { recursive: true, force: true });
    return console.log(`removed ${TEST_PACK_DIR}`);
  }
  if (!/localhost|127\.0\.0\.1/.test(process.env.SUPABASE_URL ?? "")) {
    console.error("tennis-voice plays demo rubbers: run it against the local stand-in only.");
    process.exit(2);
  }

  const served = await fetch(`${BASE_URL}/voice/${VOICE_PACK}/pack.json`);
  const v3 = served.ok && ((await served.json()) as PackIndex).provider === "tones";
  const packIndex = (await (await fetch(`${BASE_URL}/voice/${v3 ? VOICE_PACK : "en-v2"}/pack.json`)).json()) as PackIndex;
  const has = (id: string) => Boolean(packIndex.clips[id]);
  console.log(`\n━━ voice pack on the server: ${packIndex.pack} (${packIndex.provider}) ━━`);

  const { data: t } = await db().from("tournaments").select("*").eq("slug", SLUG).single();
  const tournament = t as Tournament;
  const court2 = (await db().from("courts").select("id").eq("tournament_id", tournament.id).eq("court_name", "Court 2").single()).data as { id: string };
  const tie = (await db().from("ties").select("*").eq("tournament_id", tournament.id).eq("court_id", court2.id).order("tie_order").limit(1).single()).data as { id: string };
  const rubbers = ((await db().from("matches").select("*").eq("tie_id", tie.id).order("rubber_no")).data ?? []) as Match[];
  const match = rubbers.find((r) => r.rubber_type === (v3 ? "D" : "S2"))!;
  if (match.status !== "scheduled") throw new Error(`rubber ${match.rubber_type} of the tie on Court 2 is ${match.status}: reload the demo first`);
  const teams = ((await db().from("teams").select("*").in("id", [match.team_a_id, match.team_b_id])).data ?? []) as Team[];
  const nation = (id: string | null) => teams.find((x) => x.id === id)?.nation_code ?? null;
  const [codeA, codeB] = [nation(match.team_a_id), nation(match.team_b_id)];
  const config = scoringConfigForMatch(tournament, match, null, { doubles: match.rubber_type === "D" });
  const sides = v3 && codeA && codeB ? { A: nationClip(codeA), B: nationClip(codeB) } : null;
  console.log(`${match.round_name} · ${codeA} v ${codeB}`);

  const { chromium } = req("playwright");
  const browser = await chromium.launch({
    ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}),
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  const context = await browser.newContext({ viewport: { width: 430, height: 932 } });
  await context.addCookies([{ name: COOKIE_NAME, value: sessionToken("referee"), url: BASE_URL }]);
  await context.addInitScript(() => {
    localStorage.setItem("mb_voice", JSON.stringify({ enabled: true, delayMs: 1000, leadInMs: 0, muted: false }));
    const w = window as unknown as { __calls: string[][] };
    w.__calls = [];
    window.addEventListener("mb:voice", (e) => w.__calls.push((e as CustomEvent<{ ids: string[] }>).detail.ids));
  });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/referee/matches/${match.id}/score`);
  const anyway = page.getByRole("button", { name: "Start Anyway" });
  await page.getByText("Who serves first?").or(anyway).first().waitFor();
  if (await anyway.isVisible()) await anyway.click();
  await page.getByText("Who serves first?").waitFor();
  await page.locator("button:has-text('🎾')").first().click();
  await page.getByRole("button", { name: /\+ Point/ }).first().waitFor();

  const calls = () => page.evaluate(() => (window as unknown as { __calls: string[][] }).__calls);
  const plan = v3
    ? [...taps("AbaAbAAA"), ...taps("BAbBaBABB"), ..."ABABABABABABABAB", "A", "A"].map((x) => x as TeamKey) // 6-2 3-6 [10-8]
    : taps("AAbB").slice(0, 14); // a love game, a deuce game and part of another
  let state: ScoreState = initialScoreState("A");
  let mismatches = 0;
  let timeChecked = false;
  const heard: string[][] = [];
  for (const side of plan) {
    const before = (await calls()).length;
    await page.getByRole("button", { name: /\+ Point/ }).nth(side === "A" ? 0 : 1).click();
    // The referee is asked to confirm a point that wins a game — except the match
    // point, which the Confirm result card checks instead.
    const outcome = pointOutcome(state, side, config);
    if (outcome.winsGame && !(outcome.winsMatch && config.requireResultConfirmation)) {
      await page.getByRole("button", { name: "Confirm", exact: true }).click();
    }
    const next = awardPoint(state, side, config);
    const expected = supportedCall(
      callForTransition(state, next, { corrects: false, netPoints: 1, sides, tennis: true }, config),
      has,
    );
    const deadline = Date.now() + 5000;
    let got: string[] | undefined;
    while (Date.now() < deadline) {
      const all = await calls();
      if (all.length > before) {
        got = all[all.length - 1];
        break;
      }
      await sleep(100);
    }
    heard.push(got ?? []);
    // The first changeover with a rest: wait it out, and "Time" is called when it ends.
    const rest = endsChange(state, next);
    if (v3 && !timeChecked && rest.restSeconds > 0) {
      timeChecked = true;
      const count = (await calls()).length;
      const until = Date.now() + (rest.restSeconds + 5) * 1000;
      let time = false;
      while (!time && Date.now() < until) {
        await sleep(500);
        time = (await calls()).slice(count).some((c: string[]) => JSON.stringify(c) === JSON.stringify(["time"]));
      }
      check(`"Time" called when the ${rest.restSeconds}-second ${rest.kind?.replace("_", " ")} runs out`, time);
    }
    if (JSON.stringify(got ?? null) !== JSON.stringify(expected)) {
      mismatches++;
      console.log(`   ✗ after ${side}: heard ${JSON.stringify(got ?? null)}, expected ${JSON.stringify(expected)}`);
    }
    state = next;
  }
  const spoken = heard.flat();
  check(`every point called as the rules ask (${plan.length} points)`, mismatches === 0, `${mismatches} wrong`);
  console.log(`   e.g. “${captionFor(heard.find((h) => h.includes("change-ends")) ?? heard.find((h) => h.length > 1) ?? heard[0])}”`);

  if (v3) {
    check("nations named", spoken.includes(nationClip(codeA!)) && spoken.includes(nationClip(codeB!)) && !spoken.includes("team-red"));
    check("deciding points called", spoken.includes("deciding-point"));
    check("change of ends called", spoken.includes("change-ends"));
    check("match tie-break called at one set all", spoken.filter((x) => x === "match-tie-break").length === 1);
    check("game, set and match to the winner", JSON.stringify(heard[heard.length - 1]) === JSON.stringify(["game-set-match-named", nationClip(codeA!)]));
    await page.getByRole("button", { name: "Confirm result" }).click();
    await sleep(3000);
    const { data: done } = await db().from("matches").select("status, winner_team_id").eq("id", match.id).single();
    check("the rubber is confirmed", done?.status === "completed" && done?.winner_team_id === match.team_a_id, done?.status);
  } else {
    check("no tennis clip asked of the older pack", !spoken.some(isTennisClip));
    check("sides called server and receiver", spoken.includes("leads-server") || spoken.includes("adv-server") || spoken.includes("adv-receiver"));
    await page.getByTestId("voice-button").click();
    check("the voice panel says the pack is older", await page.getByTestId("voice-older-pack").isVisible());
  }
  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Finals replay gate: both finals of the replay demo played from the admin Replay
 * page, at once, in two tabs, while the court TVs are photographed. Checks every
 * rubber ends on its real score, the boys' doubles is dropped once the tie is
 * decided, and each tie lands on its real result (2-0 and 2-1).
 *
 * It plays the demo, so it runs against the local stand-in only, on a freshly
 * loaded finals-demo.sql. Screenshots go to OUT.
 *
 *   OUT=/tmp/replay npx tsx --env-file=.env.localdb scripts/e2e/tennis-replay.ts
 */
import { createRequire } from "module";
import { mkdirSync } from "fs";
import { db } from "../../src/lib/supabase";
import type { CompletedSet, Match } from "../../src/lib/types";
import { BASE_URL, COOKIE_NAME, sessionToken } from "./lib/session";

const req = createRequire(`${process.env.PLAYWRIGHT_ROOT ?? "/opt/node22/lib/node_modules"}/`);
const OUT = process.env.OUT ?? "/tmp/tennis-replay";
const SLUG = "junior-team-finals-replay-demo";
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (sets: CompletedSet[]) => sets.map((c) => (c.matchTiebreak && c.tiebreak ? `[${c.tiebreak.a}-${c.tiebreak.b}]` : `${c.teamAGames}-${c.teamBGames}`)).join(" ");

async function main() {
  if (!/localhost|127\.0\.0\.1/.test(process.env.SUPABASE_URL ?? "")) {
    console.error("tennis-replay plays the demo: run it against the local stand-in only.");
    process.exit(2);
  }
  mkdirSync(OUT, { recursive: true });
  const { data: t } = await db().from("tournaments").select("id, format_config").eq("slug", SLUG).single();
  if (!t) throw new Error("load finals-demo.sql first");
  const replays = (t.format_config as { ties: { replays: Record<string, string> } }).ties.replays;

  const { chromium } = req("playwright");
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const admin = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await admin.addCookies([{ name: COOKIE_NAME, value: sessionToken("admin"), url: BASE_URL }]);
  const walls = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const tv = async (key: string) => {
    const p = await walls.newPage();
    await p.goto(`${BASE_URL}/t/${SLUG}/screen/${key}`);
    return p;
  };
  const [court1, court2] = [await tv("court-1-tv"), await tv("court-2-tv")];

  const seen: Record<string, Set<string>> = { c1: new Set(), c2: new Set() };
  // Both line-ups, before anything is played.
  for (const [key, page] of [["c1", court1], ["c2", court2]] as const) {
    await page.waitForSelector('[data-scene="lineup"]');
    await sleep(1500);
    await page.screenshot({ path: `${OUT}/${key}-1-lineup.png` });
    seen[key].add("lineup");
  }

  // One tab per final, so both courts play at once.
  const consoles = [];
  for (const i of [0, 1]) {
    const page = await admin.newPage();
    await page.goto(`${BASE_URL}/admin/tournaments/${t.id}/replay`);
    await page.getByTestId("replay-pace").selectOption("1.5");
    await page.getByTestId("replay-play").nth(i).click();
    consoles.push(page);
  }

  const shot = async (page: typeof court1, name: string) => page.screenshot({ path: `${OUT}/${name}.png` });
  const scene = (page: typeof court1) => page.getAttribute("[data-scene]", "data-scene");
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    for (const [key, page] of [["c1", court1], ["c2", court2]] as const) {
      const s = await scene(page);
      if (s && !seen[key].has(s)) {
        seen[key].add(s);
        await sleep(1200);
        await shot(page, `${key}-${seen[key].size}-${s}`);
      }
    }
    // Finished, or stopped on an error: either way the console says so.
    const said = await Promise.all(consoles.map((p) => p.getByTestId("replay-message").textContent({ timeout: 100 }).catch(() => null)));
    if (said.every((m) => m?.includes("replay finished")) || said.some((m) => m && !m.includes("replay finished"))) break;
    await sleep(500);
  }
  await sleep(4000);
  await shot(court1, "c1-final");
  await shot(court2, "c2-final");
  const main = await tv("main");
  await sleep(3000);
  await shot(main, "main-both-finals");

  const msgs = await Promise.all(consoles.map((p) => p.getByTestId("replay-message").textContent()));
  check("both replays finished", msgs.every((m) => m?.includes("replay finished")), JSON.stringify(msgs));
  const matches = ((await db().from("matches").select("*").eq("tournament_id", t.id)).data ?? []) as Match[];
  const snaps = new Map(((await db().from("match_score_snapshots").select("match_id, completed_sets").eq("tournament_id", t.id)).data ?? []).map((s) => [s.match_id as string, s.completed_sets as CompletedSet[]]));
  for (const [id, want] of Object.entries(replays)) {
    const m = matches.find((x) => x.id === id)!;
    check(`${m.round_name} ends ${want}`, m.status === "completed" && line(snaps.get(id) ?? []) === want, `${m.status} ${line(snaps.get(id) ?? [])}`);
  }
  const boysDoubles = matches.find((m) => m.rubber_type === "D" && !replays[m.id]);
  check("the boys' doubles is not played once USA lead 2-0", boysDoubles?.status === "cancelled", boysDoubles?.status);
  const ties = ((await db().from("ties").select("round_name, status, rubbers_a, rubbers_b").eq("tournament_id", t.id)).data ?? []) as { round_name: string; status: string; rubbers_a: number; rubbers_b: number }[];
  for (const tie of ties) console.log(`   ${tie.round_name}: ${tie.status} ${tie.rubbers_a}-${tie.rubbers_b}`);
  check("Davis Cup Junior final: USA d. Japan 2-0", ties.some((x) => x.round_name.startsWith("Davis") && x.status === "completed" && x.rubbers_a === 2 && x.rubbers_b === 0));
  check("BJK Cup Junior final: USA d. Romania 2-1", ties.some((x) => x.round_name.startsWith("Billie") && x.status === "completed" && x.rubbers_a === 2 && x.rubbers_b === 1));
  for (const key of ["c1", "c2"] as const) {
    check(`Court ${key[1]} TV went through every scene`, ["lineup", "walkon", "live", "rubber_won", "tie_score"].every((s) => seen[key].has(s)), [...seen[key]].join(" → "));
  }
  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

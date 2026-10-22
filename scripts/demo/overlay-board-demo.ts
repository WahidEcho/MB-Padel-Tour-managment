/**
 * Broadcast board demo (stand-in only): one tournament, five courts, each frozen
 * in a state the "Momentum · neon" overlay draws differently, for screenshots.
 *
 *   Court 1  singles mid-game              → compact
 *   Court 2  doubles at a changeover timer → full, "Changeover 0:20"
 *   Court 3  singles at a set break timer  → full, "Set break 1:29"
 *   Court 4  doubles just finished         → full, "Final"
 *   Court 5  doubles in a super tie-break  → compact, "Super tie-break"
 *
 *   npx tsx --env-file=.env.localdb scripts/demo/overlay-board-demo.ts      (prints the overlay URLs)
 *   CLEAN=1 npx tsx --env-file=.env.localdb scripts/demo/overlay-board-demo.ts
 */
import { randomUUID } from "crypto";
import { db } from "../../src/lib/supabase";
import { awardPoint, initialScoreState, type ScoreState, type TeamKey } from "../../src/lib/scoring/engine";
import { startClock } from "../../src/lib/scoring/timing";
import { scoringConfigForMatch } from "../../src/lib/scoring/rules";
import { snapshotRowFromState } from "../../src/lib/live/delay";
import { DEFAULT_TENNIS_SCORING_CONFIG, type Match } from "../../src/lib/types";
import { assertStandIn, fixtures } from "../e2e/lib/fixtures";

const SLUG_PREFIX = "board-demo";

/** A game: the winner takes it with the loser on `loser` points (0..2). */
const other = (w: TeamKey): TeamKey => (w === "A" ? "B" : "A");
const game = (w: TeamKey, loser = 1): TeamKey[] => [...Array.from({ length: loser }, () => other(w)), w, w, w, w];
const sets = (spec: string): TeamKey[] => spec.split("").flatMap((c, i) => game(c as TeamKey, i % 3));

async function main() {
  assertStandIn("overlay-board-demo");
  const { data: old } = await db().from("tournaments").select("id").like("slug", `${SLUG_PREFIX}%`);
  for (const t of (old ?? []) as { id: string }[]) await db().from("tournaments").delete().eq("id", t.id);
  if (process.env.CLEAN === "1") return console.log("removed");

  const f = fixtures(randomUUID().slice(0, 4));
  const T = await f.tournament({ name: "Board Demo", sport: "tennis", scoring: DEFAULT_TENNIS_SCORING_CONFIG as unknown as Record<string, unknown>, rules: { features: { tvTimers: true, tvAces: true, ace: true } } });
  await db().from("tournaments").update({ public_access_enabled: true, timezone: "Africa/Cairo", slug: SLUG_PREFIX, name: "J200 Cairo", branding_config: { liveVideo: { overlayTitle: "J200 Cairo" } } }).eq("id", T);
  const { data: trow } = await db().from("tournaments").select("*").eq("id", T).single();
  const tour = trow as { id: string; sport: string; scoring_config: unknown };
  const courts = await f.courts(T, 5);

  const entry = async (name: string, code: string, iso2: string, players: string[]) => {
    const { data } = await db().from("teams").insert({ tournament_id: T, team_name: name, nation_code: code, iso2 }).select("id").single();
    const id = (data as { id: string }).id;
    const { data: ps } = await db().from("players").insert(players.map((p, i) => ({ tournament_id: T, team_id: id, full_name: p, player_order: i + 1 }))).select("id, player_order");
    return { id, players: ((ps ?? []) as { id: string; player_order: number }[]).sort((a, b) => a.player_order - b.player_order).map((p) => p.id) };
  };
  const MARTIN = await entry("Matisse Martin", "FRA", "fr", ["Matisse Martin"]);
  const GENIDY = await entry("Mohamed Genidy", "EGY", "eg", ["Mohamed Genidy"]);
  const ROSSI = await entry("Luca Rossi", "ITA", "it", ["Luca Rossi"]);
  const GARCIA = await entry("Pablo Garcia", "ESP", "es", ["Pablo Garcia"]);
  const EGYD = await entry("Genidy / Mourid", "EGY", "eg", ["Mohamed Genidy", "Youssef Mourid"]);
  const AUTD = await entry("Niedermayr / Raser", "AUT", "at", ["Gabriel Niedermayr", "Felix Raser"]);
  const JPND = await entry("Sato / Tanaka", "JPN", "jp", ["Kenji Sato", "Riku Tanaka"]);
  const USAD = await entry("Smith / Brown", "USA", "us", ["Jack Smith", "Leo Brown"]);

  const now = Date.now();
  const iso = (ms: number) => new Date(now + ms).toISOString();
  const singles = scoringConfigForMatch(tour as never, { stage: "semi_final" });
  const doubles = scoringConfigForMatch(tour as never, { stage: "semi_final" }, null, { doubles: true });

  /** A match on a court, played point by point into score_events and its snapshot. */
  async function court(
    courtId: string,
    a: { id: string; players: string[] },
    b: { id: string; players: string[] },
    round: string,
    points: TeamKey[],
    o: { doubles?: boolean; clock?: { kind: "changeover" | "set_break"; agoMs: number }; finished?: boolean } = {},
  ) {
    const rules = o.doubles ? doubles : singles;
    const m = await f.match(T, {
      team_a_id: a.id, team_b_id: b.id, court_id: courtId, stage: "semi_final", round_name: round, status: o.finished ? "completed" : "live",
      team_a_player_ids: a.players, team_b_player_ids: b.players, started_at: iso(-points.length * 40_000 - 60_000),
    } as Partial<Match> & { team_a_id: string; team_b_id: string });
    let s: ScoreState = initialScoreState("A");
    const rows: Record<string, unknown>[] = [];
    let n = 0;
    const push = (type: string, prev: ScoreState | null, next: ScoreState, team: string | null, note: Record<string, unknown> | null, at: string) =>
      rows.push({
        client_event_id: randomUUID(), tournament_id: T, match_id: m.id, event_number: ++n, event_type: type, team_id: team,
        previous_state_json: prev, new_state_json: next, created_at_client: at, sync_status: "synced", note: note ? JSON.stringify(note) : null,
      });
    push("MATCH_STARTED", null, s, null, null, iso(-points.length * 40_000 - 50_000));
    points.forEach((w, i) => {
      if (s.matchOver) return;
      const next = awardPoint(s, w, rules);
      // Every ninth point an ace, for the stat boxes.
      push("POINT_AWARDED", s, next, w === "A" ? a.id : b.id, i % 9 === 4 ? { ace: true } : null, iso(-(points.length - i) * 40_000));
      s = next;
    });
    if (o.clock) s = startClock(s, o.clock.kind, iso(-o.clock.agoMs));
    for (let i = 0; i < rows.length; i += 200) await db().from("score_events").insert(rows.slice(i, i + 200));
    await db().from("match_score_snapshots").upsert(snapshotRowFromState(m, s, n, {}, iso(-1_000)));
    console.log(round, JSON.stringify({ sets: s.completedSets.map((x) => `${x.teamAGames}-${x.teamBGames}`), games: [s.teamA.games, s.teamB.games], pts: [s.teamA.points, s.teamB.points], tb: [s.teamA.tiebreakPoints, s.teamB.tiebreakPoints], over: s.matchOver, clock: s.clock?.kind }));
    if (o.finished) await db().from("matches").update({ winner_team_id: s.winner === "A" ? a.id : b.id, ended_at: iso(-60_000), result_source: "point_by_point" }).eq("id", m.id);
    return { m, s };
  }

  // Court 1: Martin 6-4, 2-3, 30-15 (compact).
  await court(courts[0], MARTIN, GENIDY, "Boys' Singles SF", [...sets("ABABABABAA"), ...sets("ABBAB"), "A", "B", "A"]);
  // Court 2: doubles 6-4, 3-2 just won, changeover running 20 s (full).
  await court(courts[1], EGYD, AUTD, "Boys' Doubles SF", [...sets("ABABABABAA"), ...sets("ABABA")], { doubles: true, clock: { kind: "changeover", agoMs: 20_000 } });
  // Court 3: singles first set 6-3 just won, set break 1:29 in (full).
  await court(courts[2], ROSSI, GARCIA, "Boys' Singles QF", sets("ABABABAAA"), { clock: { kind: "set_break", agoMs: 89_000 } });
  // Court 4: doubles 6-4 3-6 [10-7], finished (full, Final).
  await court(courts[3], EGYD, AUTD, "Boys' Doubles Final", [...sets("ABABABABAA"), ...sets("BABABABBB"), ..."ABABAABBAABABAABA".split("") as TeamKey[]], { doubles: true, finished: true });
  // Court 5: doubles 6-4 4-6, super tie-break 6-5 (compact).
  await court(courts[4], JPND, USAD, "Girls' Doubles SF", [...sets("ABABABABAA"), ...sets("BABABABABB"), ..."ABABABBAAAB".split("") as TeamKey[]], { doubles: true });

  const base = process.env.BASE_URL ?? "http://localhost:3131";
  for (const [i, c] of courts.entries()) console.log(`Court ${i + 1}  ${base}/t/${SLUG_PREFIX}/overlay/${c}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);

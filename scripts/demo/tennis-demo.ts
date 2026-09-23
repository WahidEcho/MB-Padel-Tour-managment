/**
 * Builds the tennis demo event as SQL: "Junior Team Finals Demo (Cairo 2026)".
 *
 * Real past finalists (2024–25 Junior Davis Cup / Junior BJK Cup) in three
 * round-robin groups — girls' singles, boys' singles, girls' doubles — on two
 * courts, one TV each. Some matches are finished (the real 2024 final results,
 * replayed point by point through the engine), two are left live mid-match (one
 * doubles in a match tie-break) and the rest are scheduled, so the event can be
 * picked up on a referee phone and carried on.
 *
 * Everything goes through the app's own pure code — round robin, scoring engine,
 * standings — so the rows are what the app itself would have written. Prints SQL
 * on stdout; nothing here touches the database, so it runs anywhere.
 *
 *   npx tsx scripts/demo/tennis-demo.ts > demo.sql
 *
 * Loaded on 2026-09-23 as slug junior-team-finals-demo-cairo-2026 and kept, with
 * its live matches left unfinished for testing. Remove it with:
 *   delete from tournaments where slug = 'junior-team-finals-demo-cairo-2026';
 */
import { roundRobin } from "../../src/lib/roundrobin";
import { awardPoint, initialScoreState, type ScoreState, type TeamKey } from "../../src/lib/scoring/engine";
import { applyViolation } from "../../src/lib/scoring/conduct";
import { isDoublesMatch, scoringConfigForMatch } from "../../src/lib/scoring/rules";
import { applyQualification, calculateStandings } from "../../src/lib/standings";
import { DEFAULT_TENNIS_SCORING_CONFIG, type Match, type MatchSnapshot, type ScoringConfig } from "../../src/lib/types";

/**
 * Ids are short readable keys that the database turns into uuids with md5(), so
 * the SQL stays small enough to paste into a SQL console by hand.
 */
let keyCount = 0;
const key = (kind: string) => `jtf26:${kind}:${++keyCount}`;
const T = "jtf26:tournament";
const SLUG = "junior-team-finals-demo-cairo-2026";
const now = Date.now();
const iso = (offsetMin: number) => new Date(now + offsetMin * 60_000).toISOString();

const scoring: ScoringConfig = { ...DEFAULT_TENNIS_SCORING_CONFIG, requireResultConfirmation: true };
const tournament = { sport: "tennis", scoring_config: scoring };

/* ---------------- entries ---------------- */
interface Entry { id: string; name: string; seed: number; players: string[] }
const entry = (name: string, seed: number, ...players: string[]): Entry => ({ id: key("team"), name, seed, players });

const GROUPS: { name: string; entries: Entry[] }[] = [
  {
    name: "Girls Singles",
    entries: [
      entry("Popa (ROU)", 1, "Giulia Safina Popa"),
      entry("Pareja (USA)", 2, "Julieta Pareja"),
      entry("Burcescu (ROU)", 3, "Maia Ilinca Burcescu"),
      entry("K. Penickova (USA)", 4, "Kristina Penickova"),
    ],
  },
  {
    name: "Boys Singles",
    entries: [
      entry("Antonius (USA)", 5, "Michael Antonius"),
      entry("Johnson (USA)", 6, "Andrew Johnson"),
      entry("Watanabe (JPN)", 7, "Kanta Watanabe"),
      entry("Mrva (CZE)", 8, "Maxim Mrva"),
    ],
  },
  {
    name: "Girls Doubles",
    entries: [
      entry("Grant / Pareja (USA)", 9, "Tyra Caterina Grant", "Julieta Pareja"),
      entry("Popa / Burcescu (ROU)", 10, "Giulia Safina Popa", "Maia Ilinca Burcescu"),
      entry("Penickova / Penickova (USA)", 11, "Kristina Penickova", "Annika Penickova"),
      entry("Lagaev / Celebrini (CAN)", 12, "Nadia Lagaev", "Charlize Celebrini"),
    ],
  },
];

/* ---------------- SQL helpers ---------------- */
const isKey = (v: unknown): v is string => typeof v === "string" && v.startsWith("jtf26:");
const q = (v: unknown): string => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (isKey(v)) return `md5('${v}')::uuid`;
  if (Array.isArray(v) && v.length && v.every(isKey)) return `array[${v.map((x) => q(x)).join(",")}]`;
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
};
const statements: string[] = [];
function insert(table: string, rows: Record<string, unknown>[]) {
  if (rows.length === 0) return;
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => rows.some((r) => r[c] !== undefined));
  statements.push(
    `insert into ${table} (${cols.join(", ")}) values\n${rows.map((r) => `(${cols.map((c) => q(r[c])).join(", ")})`).join(",\n")};`,
  );
}

/* ---------------- tournament, courts, screens ---------------- */
insert("tournaments", [
  {
    id: T,
    name: "Junior Team Finals Demo (Cairo 2026)",
    slug: SLUG,
    sport: "tennis",
    kind: "tournament",
    status: "active",
    is_demo: true,
    public_access_enabled: true,
    created_by: "admin",
    scoring_config: scoring,
    format_config: { type: "group_knockout", qualifyPerGroup: 2, thirdPlaceMatch: false },
    branding_config: {
      background: {
        url: "/backgrounds/night-clay.svg",
        kind: "svg",
        mime: "image/svg+xml",
        bytes: 8746,
        dim: "light",
        showOnPublic: false,
      },
      holding: { title: "Junior Team Finals · Cairo 2026", message: "Play resumes shortly" },
    },
    lower_third_text: "Demo event · past finalists · Smash Sporting Club, Cairo · 2–8 Nov 2026",
  },
]);
const courts = [1, 2].map((n) => ({ id: key("court"), tournament_id: T, court_name: `Court ${n}`, court_order: n }));
insert("courts", courts);
insert("screen_settings", [
  { tournament_id: T, screen_key: "main", screen_name: "Main", display_mode: "live", court_ids: courts.map((c) => c.id), focus_court_id: null },
  { tournament_id: T, screen_key: "court-1-tv", screen_name: "Court 1 TV", display_mode: "live", court_ids: [courts[0].id], focus_court_id: courts[0].id },
  { tournament_id: T, screen_key: "court-2-tv", screen_name: "Court 2 TV", display_mode: "live", court_ids: [courts[1].id], focus_court_id: courts[1].id },
]);

/* ---------------- teams, players, groups ---------------- */
const all = GROUPS.flatMap((g) => g.entries);
insert("teams", all.map((e) => ({ id: e.id, tournament_id: T, team_name: e.name, seed_number: e.seed, check_in_status: "checked_in", team_status: "active" })));
insert(
  "players",
  all.flatMap((e) => e.players.map((p, i) => ({ tournament_id: T, team_id: e.id, player_order: i + 1, full_name: p }))),
);
const groups = GROUPS.map((g, i) => ({ id: key("group"), tournament_id: T, group_name: g.name, group_order: i + 1, status: "published" }));
insert("groups", groups);
insert(
  "group_teams",
  GROUPS.flatMap((g, gi) => g.entries.map((e, pos) => ({ tournament_id: T, group_id: groups[gi].id, team_id: e.id, position: pos + 1 }))),
);

/* ---------------- matches: the app's own round robin ---------------- */
const pending = GROUPS.flatMap((g, gi) =>
  roundRobin(g.entries.map((e) => e.id)).map((p) => ({ group: gi, round: p.round, a: p.teamA, b: p.teamB, round_name: `${g.name} Round ${p.round}` })),
).sort((x, y) => x.round - y.round || x.group - y.group);
const matches: Match[] = pending.map((m, i) => ({
  id: key("match"),
  tournament_id: T,
  stage: "group",
  group_id: groups[m.group].id,
  round_name: m.round_name,
  match_order: i + 1,
  court_id: courts[i % 2].id,
  scheduled_time: iso(-60 + i * 75),
  team_a_id: m.a,
  team_b_id: m.b,
  status: "scheduled",
  winner_team_id: null,
  started_at: null,
  ended_at: null,
}) as unknown as Match);
const byId = new Map(all.map((e) => [e.id, e]));
const find = (a: string, b: string) => {
  const m = matches.find((x) => {
    const n = [byId.get(x.team_a_id!)!.name, byId.get(x.team_b_id!)!.name];
    return (n[0].startsWith(a) && n[1].startsWith(b)) || (n[0].startsWith(b) && n[1].startsWith(a));
  });
  if (!m) throw new Error(`no match ${a} v ${b}`);
  return m;
};

/* ---------------- play: point by point through the engine ---------------- */
function rulesFor(m: Match) {
  return scoringConfigForMatch(tournament, m, null, { doubles: isDoublesMatch(byId.get(m.team_a_id!)!, byId.get(m.team_b_id!)!) });
}
/** Scripted sets from side X's point of view, where X is the named winner, as games won in order. */
function playScript(m: Match, winnerIsA: boolean, script: (string | number)[], cfg: ScoringConfig): ScoreState[] {
  // script: "W" = winner's game, "L" = loser's game, "T:w-l" = tie-break points, "M:w-l" = match tie-break
  const W: TeamKey = winnerIsA ? "A" : "B";
  const L: TeamKey = winnerIsA ? "B" : "A";
  let s = initialScoreState("A");
  const trail = [s];
  const pt = (k: TeamKey) => {
    s = awardPoint(s, k, cfg);
    trail.push(s);
  };
  for (const step of script) {
    const str = String(step);
    if (str === "W" || str === "L") {
      const k = str === "W" ? W : L;
      const o = k === W ? L : W;
      pt(o); pt(k); pt(k); pt(o); pt(k); pt(k); // 40-30 style game
    } else if (str.startsWith("T:") || str.startsWith("M:")) {
      const [w, l] = str.slice(2).split("-").map(Number);
      for (let i = 0; i < l; i++) { pt(W); pt(L); }
      for (let i = l; i < w; i++) pt(W);
    } else if (str.startsWith("P:")) {
      // Partial game: points to winner, then to loser
      const [w, l] = str.slice(2).split("-").map(Number);
      for (let i = 0; i < Math.max(w, l); i++) { if (i < w) pt(W); if (i < l) pt(L); }
    }
  }
  return trail;
}
const games = (w: number, l: number) => {
  const out: string[] = [];
  const shared = Math.min(w, l);
  for (let i = 0; i < shared; i++) out.push("W", "L");
  for (let i = shared; i < Math.max(w, l); i++) out.push(w > l ? "W" : "L");
  return out;
};

const snapshots: MatchSnapshot[] = [];
const events: Record<string, unknown>[] = [];
function record(m: Match, trail: ScoreState[], finished: boolean, extra?: (s: ScoreState) => ScoreState) {
  let final = trail[trail.length - 1];
  const beforeLast = trail[trail.length - 2];
  if (extra) final = extra(final);
  const ev = (n: number, type: string, prev: ScoreState | null, next: ScoreState, note?: string, teamId?: string | null) =>
    events.push({
      client_event_id: `${m.id}:${n}`,
      tournament_id: T,
      match_id: m.id,
      event_number: n,
      event_type: type,
      team_id: teamId ?? null,
      previous_state_json: prev,
      new_state_json: next,
      created_by_role: "admin",
      created_at_client: iso(-30),
      sync_status: "synced",
      note: note ?? null,
    });
  ev(1, "MATCH_STARTED", null, trail[0], JSON.stringify({ first_server: "A" }));
  let n = 1;
  if (finished) {
    ev(++n, "DEMO_REPLAY", null, beforeLast, `Demo data: ${trail.length - 2} points replayed through the scoring engine`);
    const winnerId = final.winner === "A" ? m.team_a_id : m.team_b_id;
    ev(++n, "POINT_AWARDED", beforeLast, final, undefined, winnerId);
    // The winner is on the event's team_id; a key inside the note would not be turned into a uuid.
    ev(++n, "MATCH_ENDED", final, final, undefined, winnerId);
    m.status = "completed";
    m.winner_team_id = winnerId;
    m.started_at = iso(-150);
    m.ended_at = iso(-60);
  } else {
    ev(++n, "DEMO_REPLAY", null, final, `Demo data: ${trail.length - 1} points replayed through the scoring engine; the match is live — carry on scoring`);
    m.status = "live";
    m.started_at = iso(-40);
  }
  const serving = final.servingTeam === "A" ? m.team_a_id : final.servingTeam === "B" ? m.team_b_id : null;
  if (!finished) m.serving_team_id = serving;
  snapshots.push({
    match_id: m.id,
    tournament_id: T,
    current_set_number: final.currentSet,
    team_a_point_label: final.teamA.points,
    team_b_point_label: final.teamB.points,
    team_a_games: final.teamA.games,
    team_b_games: final.teamB.games,
    team_a_sets: final.teamA.sets,
    team_b_sets: final.teamB.sets,
    is_tiebreak: final.isTiebreak,
    tiebreak_team_a_points: final.teamA.tiebreakPoints,
    tiebreak_team_b_points: final.teamB.tiebreakPoints,
    serving_team_id: serving,
    last_event_number: n,
    last_event_type: finished ? "MATCH_ENDED" : "DEMO_REPLAY",
    last_undo_event_number: 0,
    completed_sets: final.completedSets,
    snapshot_json: final,
  } as unknown as MatchSnapshot);
  return final;
}

// Finished: the real 2024 Junior BJK Cup final results.
{
  const m = find("Popa (ROU)", "Pareja (USA)");
  const aIsPopa = byId.get(m.team_a_id!)!.name.startsWith("Popa");
  const f = record(m, playScript(m, aIsPopa, [...games(7, 5), ...games(6, 4)], rulesFor(m)), true);
  if (!f.matchOver) throw new Error("Popa v Pareja did not finish");
}
{
  const m = find("Grant / Pareja", "Popa / Burcescu");
  const aIsUsa = byId.get(m.team_a_id!)!.name.startsWith("Grant");
  const f = record(m, playScript(m, aIsUsa, [...games(6, 1), ...games(7, 5)], rulesFor(m)), true);
  if (!f.matchOver) throw new Error("the doubles did not finish");
}
// Live on Court 1 and Court 2 (moved there so each TV has one): mid-match.
const liveSingles = find("Burcescu", "K. Penickova");
const liveDoubles = find("Penickova / Penickova", "Lagaev");
liveSingles.court_id = courts[0].id;
liveDoubles.court_id = courts[1].id;
{
  const m = liveSingles;
  const aIsB = byId.get(m.team_a_id!)!.name.startsWith("Burcescu");
  const cfg = rulesFor(m);
  const f = record(m, playScript(m, aIsB, [...games(6, 4), "W", "L", "W", "L", "L", "P:2-1"], cfg), false, (s) =>
    // A time-violation warning already on the record, so the log shows on the referee phone.
    applyViolation(s, { team: aIsB ? "B" : "A", offence: "time", penalty: "warning" }, cfg),
  );
  if (f.matchOver || f.completedSets.length !== 1) throw new Error("live singles state is wrong");
}
{
  const m = liveDoubles;
  const aIsUsa = byId.get(m.team_a_id!)!.name.startsWith("Penickova");
  const f = record(m, playScript(m, aIsUsa, [...games(6, 3), ...games(3, 6), "M:4-3"], rulesFor(m)), false);
  if (!f.isMatchTiebreak) throw new Error("the live doubles is not in a match tie-break");
}
// Everything live or finished goes to the top of the order of play.
const firstUp = matches.filter((m) => m.status !== "scheduled");
const rest = matches.filter((m) => m.status === "scheduled");
[...firstUp, ...rest].forEach((m, i) => {
  m.match_order = i + 1;
  // Two courts, a slot every 90 minutes; the scheduled ones alternate courts.
  if (m.status === "scheduled") m.court_id = courts[i % 2].id;
  m.scheduled_time = iso(-150 + Math.floor(i / 2) * 90);
});

insert(
  "matches",
  matches.map((m) => ({
    id: m.id, tournament_id: T, stage: m.stage, group_id: m.group_id, round_name: m.round_name,
    match_order: m.match_order, court_id: m.court_id, scheduled_time: m.scheduled_time,
    team_a_id: m.team_a_id, team_b_id: m.team_b_id, status: m.status, winner_team_id: m.winner_team_id,
    serving_team_id: m.serving_team_id ?? null, started_at: m.started_at, ended_at: m.ended_at,
  })),
);
insert("match_score_snapshots", snapshots as unknown as Record<string, unknown>[]);
insert("score_events", events);

/* ---------------- standings: the app's own calculation ---------------- */
const snapBy = new Map(snapshots.map((s) => [s.match_id, s]));
const standingRows = GROUPS.flatMap((g, gi) => {
  const gm = matches.filter((m) => m.group_id === groups[gi].id);
  const rows = calculateStandings(T, groups[gi].id, g.entries.map((e) => e.id), gm.map((m) => ({ match: m, snapshot: snapBy.get(m.id) ?? null })), new Set(), 6);
  applyQualification(rows, 2, false, 0);
  return rows;
});
insert("standings_snapshots", standingRows as unknown as Record<string, unknown>[]);

process.stdout.write(`-- ${SLUG}: tournament id is md5('${T}')::uuid\n${statements.join("\n\n")}\n`);
process.stderr.write(
  `tournament ${T}\n${matches.length} matches: ${matches.filter((m) => m.status === "completed").length} finished, ${matches.filter((m) => m.status === "live").length} live\n` +
    `live singles ${liveSingles.id} · live doubles ${liveDoubles.id}\n`,
);

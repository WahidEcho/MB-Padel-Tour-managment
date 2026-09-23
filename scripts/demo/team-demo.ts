/**
 * Builds a nations team-competition demo as SQL: "Junior Team Finals Demo —
 * Nations (Cairo 2026)". Eight nations of past junior finalists in two groups
 * of four, every group tie generated with its three rubbers and both captains'
 * line-ups nominated (round 1 locked), and nothing played — so the event can be
 * run from a referee phone, tie by tie, through the groups and into the
 * placement draws.
 *
 * Uses the app's own round robin and order of play, with short keys the
 * database turns into uuids (md5), so the SQL is small enough to apply by hand.
 *
 *   npx tsx scripts/demo/team-demo.ts > team-demo.sql
 *
 * Remove it with: delete from tournaments where slug = 'junior-team-finals-nations-demo';
 */
import { roundRobin } from "../../src/lib/roundrobin";
import { nationByCode } from "../../src/lib/tennis/nations";
import { RUBBER_LABELS, rubberPlan } from "../../src/lib/tennis/ties";
import { DEFAULT_TENNIS_SCORING_CONFIG } from "../../src/lib/types";

const T = "jtfn26:tournament";
const SLUG = "junior-team-finals-nations-demo";
const k = (...parts: (string | number)[]) => `jtfn26:${parts.join(":")}`;
const isKey = (v: unknown): v is string => typeof v === "string" && v.startsWith("jtfn26:");
const q = (v: unknown): string => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (isKey(v)) return `md5('${v}')::uuid`;
  if (Array.isArray(v) && v.length && v.every(isKey)) return `array[${v.map(q).join(",")}]`;
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
};
const out: string[] = [];
function insert(table: string, rows: Record<string, unknown>[]) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  out.push(`insert into ${table} (${cols.join(", ")}) values\n${rows.map((r) => `(${cols.map((c) => q(r[c])).join(", ")})`).join(",\n")};`);
}

// Girls' event, seeded; real 2024–25 finalists where their names are public.
const FIELD: [string, string, string[]][] = [
  ["USA", "Sylvain Guichard", ["Julieta Pareja", "Kristina Penickova", "Annika Penickova"]],
  ["ROU", "Captain ROU", ["Giulia Safina Popa", "Maia Ilinca Burcescu", "Andreea Soare"]],
  ["CZE", "Captain CZE", ["Tereza Novak", "Klara Dvorak", "Ema Kral"]],
  ["FRA", "Captain FRA", ["Cindy Langlais", "Lea Martin", "Chloe Bernard"]],
  ["CAN", "Captain CAN", ["Nadia Lagaev", "Charlize Celebrini", "Emma Roy"]],
  ["EGY", "Captain EGY", ["Judy Tawila", "Farida Hassan", "Laila Adel"]],
  ["JPN", "Captain JPN", ["Yui Tanaka", "Hana Sato", "Mio Suzuki"]],
  ["ESP", "Captain ESP", ["Lucia Garcia", "Paula Lopez", "Marta Ruiz"]],
];

insert("tournaments", [
  {
    id: T,
    name: "Junior Team Finals Demo — Nations (Cairo 2026)",
    slug: SLUG,
    sport: "tennis",
    kind: "tournament",
    status: "active",
    is_demo: true,
    public_access_enabled: true,
    created_by: "admin",
    scoring_config: { ...DEFAULT_TENNIS_SCORING_CONFIG, requireResultConfirmation: true },
    format_config: { type: "group_knockout", qualifyPerGroup: 2, thirdPlaceMatch: false, ties: {} },
    branding_config: {
      background: { url: "/backgrounds/night-clay.svg", kind: "svg", mime: "image/svg+xml", bytes: 8746, dim: "light", showOnPublic: false },
      holding: { title: "Junior Team Finals · Cairo 2026", message: "Play resumes shortly" },
    },
    lower_third_text: "Demo · nations team competition · Smash Sporting Club, Cairo",
  },
]);
const courts = [1, 2].map((n) => ({ id: k("court", n), tournament_id: T, court_name: `Court ${n}`, court_order: n }));
insert("courts", courts);
insert("screen_settings", [
  { tournament_id: T, screen_key: "main", screen_name: "Main", display_mode: "live", court_ids: courts.map((c) => c.id), focus_court_id: null },
  { tournament_id: T, screen_key: "court-1-tv", screen_name: "Court 1 TV", display_mode: "live", court_ids: [courts[0].id], focus_court_id: courts[0].id },
  { tournament_id: T, screen_key: "court-2-tv", screen_name: "Court 2 TV", display_mode: "live", court_ids: [courts[1].id], focus_court_id: courts[1].id },
]);
insert(
  "teams",
  FIELD.map(([code, captain], i) => ({
    id: k("team", code),
    tournament_id: T,
    team_name: nationByCode(code)!.name,
    nation_code: code,
    iso2: nationByCode(code)!.iso2,
    captain_name: captain,
    seed_number: i + 1,
    check_in_status: "checked_in",
    team_status: "active",
  })),
);
insert(
  "players",
  FIELD.flatMap(([code, , players]) =>
    players.map((full_name, j) => ({ id: k("player", code, j + 1), tournament_id: T, team_id: k("team", code), player_order: j + 1, full_name })),
  ),
);
// Seeds 1 and 2 head the groups, then snake: A = 1,4,5,8 · B = 2,3,6,7.
const groups = [
  { id: k("group", "A"), name: "Group A", codes: ["USA", "FRA", "CAN", "ESP"] },
  { id: k("group", "B"), name: "Group B", codes: ["ROU", "CZE", "EGY", "JPN"] },
];
insert("groups", groups.map((g, i) => ({ id: g.id, tournament_id: T, group_name: g.name, group_order: i + 1, status: "published" })));
insert("group_teams", groups.flatMap((g) => g.codes.map((c, pos) => ({ tournament_id: T, group_id: g.id, team_id: k("team", c), position: pos + 1 }))));

const pending = groups
  .flatMap((g, gi) => roundRobin(g.codes).map((p) => ({ g, gi, round: p.round, a: p.teamA, b: p.teamB })))
  .sort((x, y) => x.round - y.round || x.gi - y.gi);
const start = new Date("2026-11-02T09:30:00+02:00").getTime();
const ties = pending.map((p, i) => ({
  id: k("tie", i + 1),
  tournament_id: T,
  stage: "group",
  group_id: p.g.id,
  round_no: p.round,
  round_name: `${p.g.name} · Round ${p.round}`,
  tie_order: i + 1,
  court_id: courts[i % 2].id,
  // One group round a day; group A's ties at 09:30, group B's at 14:00 (Cairo).
  scheduled_time: new Date(start + (p.round - 1) * 24 * 3600_000 + p.gi * 4.5 * 3600_000).toISOString(),
  team_a_id: k("team", p.a),
  team_b_id: k("team", p.b),
  lineup_locked_at: p.round === 1 ? new Date(start - 3600_000).toISOString() : null,
}));
insert("ties", ties);

// Rubbers: three per tie, derived in the database from the ties, so the SQL
// stays short. Nominations: No. 1 singles is the first player, No. 2 the
// second, the doubles the first and third — a common captain's pick.
out.push(`insert into matches (tournament_id, tie_id, rubber_no, rubber_type, stage, group_id, round_name, match_order, court_id, scheduled_time, team_a_id, team_b_id, team_a_player_ids, team_b_player_ids, status)
select t.tournament_id, t.id, r.no, r.type, 'group', t.group_id,
  t.round_name || ' · ' || a.nation_code || ' v ' || b.nation_code || ' · ' || r.label,
  (t.tie_order - 1) * 3 + r.no, t.court_id, t.scheduled_time + (r.no - 1) * interval '90 minutes', t.team_a_id, t.team_b_id,
  case r.type when 'S1' then array[md5('jtfn26:player:' || a.nation_code || ':1')::uuid]
              when 'S2' then array[md5('jtfn26:player:' || a.nation_code || ':2')::uuid]
              else array[md5('jtfn26:player:' || a.nation_code || ':1')::uuid, md5('jtfn26:player:' || a.nation_code || ':3')::uuid] end,
  case r.type when 'S1' then array[md5('jtfn26:player:' || b.nation_code || ':1')::uuid]
              when 'S2' then array[md5('jtfn26:player:' || b.nation_code || ':2')::uuid]
              else array[md5('jtfn26:player:' || b.nation_code || ':1')::uuid, md5('jtfn26:player:' || b.nation_code || ':3')::uuid] end,
  'scheduled'
from ties t
join teams a on a.id = t.team_a_id
join teams b on b.id = t.team_b_id
cross join (values ${rubberPlan(undefined).map((type, i) => `(${i + 1}, '${type}', '${RUBBER_LABELS[type]}')`).join(", ")}) as r(no, type, label)
where t.tournament_id = md5('${T}')::uuid;`);
insert(
  "standings_snapshots",
  groups.flatMap((g) => g.codes.map((c, i) => ({ tournament_id: T, group_id: g.id, team_id: k("team", c), rank: i + 1, played: 0, won: 0, lost: 0, points: 0, rubbers_won: 0, rubbers_lost: 0, status: "pending" }))),
);

process.stdout.write(`-- ${SLUG}\n${out.join("\n\n")}\n`);

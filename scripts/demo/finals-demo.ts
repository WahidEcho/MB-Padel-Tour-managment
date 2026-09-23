/**
 * Builds the finals replay demo as SQL: "Junior Team Finals Demo — The finals,
 * replayed". The two most recent finals, as they were played, one per court:
 *
 *   Court 1 · Davis Cup Junior Finals 2025 (Santiago): USA d. Japan 2-0
 *     No. 2 singles  Andrew Johnson d. Takahiro Kawaguchi  6-4 6-3
 *     No. 1 singles  Michael Antonius d. Kanta Watanabe    6-3 6-2
 *     Doubles        not played (the tie was decided)
 *   Court 2 · Billie Jean King Cup Junior Finals 2024 (Córdoba): USA d. Romania 2-1
 *     No. 2 singles  Tyra Grant d. Maia Ilinca Burcescu    6-2 6-1
 *     No. 1 singles  Giulia Safina Popa d. Julieta Pareja  7-5 6-4
 *     Doubles        Grant / Pareja d. Popa / Burcescu     6-1 7-5
 *
 * Squads hold only the players named in those results. Nothing is played in the
 * SQL: the results sit in the tournament's replay config, and the admin Replay
 * page plays them onto the court TVs point by point. Only the set scores are
 * real; the points inside them are made up to fit.
 *
 *   npx tsx scripts/demo/finals-demo.ts > finals-demo.sql
 *
 * Remove it with: delete from tournaments where slug = 'junior-team-finals-replay-demo';
 */
import { createHash } from "crypto";
import { nationByCode } from "../../src/lib/tennis/nations";
import { RUBBER_LABELS } from "../../src/lib/tennis/ties";
import { DEFAULT_TENNIS_SCORING_CONFIG, type RubberType } from "../../src/lib/types";

const SLUG = "junior-team-finals-replay-demo";
const k = (...parts: (string | number)[]) => `jtfr26:${parts.join(":")}`;
/** The uuid Postgres makes of md5(key)::uuid, so the replay config can name matches. */
const uuid = (key: string) => {
  const h = createHash("md5").update(key).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const isKey = (v: unknown): v is string => typeof v === "string" && v.startsWith("jtfr26:");
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
  out.push(`insert into ${table} (${cols.join(", ")}) values\n${rows.map((r) => `(${cols.map((c) => q(r[c] ?? null)).join(", ")})`).join(",\n")};`);
}

interface Final {
  key: string;
  court: number;
  title: string;
  a: { code: string; players: string[] };
  b: { code: string; players: string[] };
  /** Rubber, side A's players, side B's players (indexes into the squads), result from A's side. */
  rubbers: [RubberType, number[], number[], string | null][];
}
const FINALS: Final[] = [
  {
    key: "boys",
    court: 1,
    title: "Davis Cup Junior Final 2025 · replay",
    a: { code: "USA", players: ["Andrew Johnson", "Michael Antonius"] },
    b: { code: "JPN", players: ["Takahiro Kawaguchi", "Kanta Watanabe"] },
    rubbers: [
      ["S2", [0], [0], "6-4 6-3"],
      ["S1", [1], [1], "6-3 6-2"],
      ["D", [0, 1], [0, 1], null],
    ],
  },
  {
    key: "girls",
    court: 2,
    title: "Billie Jean King Cup Junior Final 2024 · replay",
    a: { code: "USA", players: ["Tyra Grant", "Julieta Pareja", "Kristina Penickova"] },
    b: { code: "ROU", players: ["Giulia Safina Popa", "Maia Ilinca Burcescu"] },
    rubbers: [
      ["S2", [0], [1], "6-2 6-1"],
      ["S1", [1], [0], "5-7 4-6"],
      ["D", [0, 1], [0, 1], "6-1 7-5"],
    ],
  },
];

const T = k("tournament");
const replays: Record<string, string> = {};
for (const f of FINALS) for (const [type, , , line] of f.rubbers) if (line) replays[uuid(k("match", f.key, type))] = line;

insert("tournaments", [
  {
    id: T,
    name: "Junior Team Finals Demo — The finals, replayed",
    slug: SLUG,
    sport: "tennis",
    kind: "tournament",
    status: "active",
    is_demo: true,
    public_access_enabled: true,
    created_by: "admin",
    scoring_config: { ...DEFAULT_TENNIS_SCORING_CONFIG, requireResultConfirmation: true },
    format_config: { type: "group_knockout", qualifyPerGroup: 2, thirdPlaceMatch: false, ties: { replays } },
    branding_config: {
      background: { url: "/backgrounds/night-clay.svg", kind: "svg", mime: "image/svg+xml", bytes: 8746, dim: "light", showOnPublic: false },
      holding: { title: "Junior Team Finals · Cairo 2026", message: "The finals, replayed" },
    },
    lower_third_text: "Demo · the 2024 and 2025 junior finals, replayed from their real results",
  },
]);
const courts = [1, 2].map((n) => ({ id: k("court", n), tournament_id: T, court_name: `Court ${n}`, court_order: n }));
insert("courts", courts);
insert("screen_settings", [
  { tournament_id: T, screen_key: "main", screen_name: "Main", display_mode: "live", court_ids: courts.map((c) => c.id), focus_court_id: null },
  { tournament_id: T, screen_key: "court-1-tv", screen_name: "Court 1 TV", display_mode: "live", court_ids: [courts[0].id], focus_court_id: courts[0].id },
  { tournament_id: T, screen_key: "court-2-tv", screen_name: "Court 2 TV", display_mode: "live", court_ids: [courts[1].id], focus_court_id: courts[1].id },
]);
const side = (f: Final, s: "a" | "b") => ({ id: k("team", f.key, s), ...f[s] });
insert(
  "teams",
  FINALS.flatMap((f) => (["a", "b"] as const).map((s) => side(f, s))).map((t, i) => ({
    id: t.id,
    tournament_id: T,
    team_name: nationByCode(t.code)!.name,
    nation_code: t.code,
    iso2: nationByCode(t.code)!.iso2,
    captain_name: null,
    seed_number: i % 2 === 0 ? 1 : 2,
    check_in_status: "checked_in",
    team_status: "active",
  })),
);
insert(
  "players",
  FINALS.flatMap((f) =>
    (["a", "b"] as const).flatMap((s) =>
      f[s].players.map((full_name, j) => ({ id: k("player", f.key, s, j), tournament_id: T, team_id: k("team", f.key, s), player_order: j + 1, full_name })),
    ),
  ),
);
const today = new Date();
today.setUTCHours(8, 0, 0, 0); // 10:00 in Cairo
insert(
  "ties",
  FINALS.map((f, i) => ({
    id: k("tie", f.key),
    tournament_id: T,
    stage: "placement",
    places_from: 1,
    places_to: 2,
    round_no: 1,
    round_name: f.title,
    tie_order: i + 1,
    court_id: courts[f.court - 1].id,
    scheduled_time: today.toISOString(),
    team_a_id: k("team", f.key, "a"),
    team_b_id: k("team", f.key, "b"),
    lineup_locked_at: today.toISOString(),
  })),
);
insert(
  "matches",
  FINALS.flatMap((f, i) =>
    f.rubbers.map(([type, pa, pb], j) => ({
      id: k("match", f.key, type),
      tournament_id: T,
      tie_id: k("tie", f.key),
      rubber_no: j + 1,
      rubber_type: type,
      stage: "knockout",
      round_name: `${f.title} · ${f.a.code} v ${f.b.code} · ${RUBBER_LABELS[type]}`,
      match_order: i * 3 + j + 1,
      court_id: courts[f.court - 1].id,
      scheduled_time: today.toISOString(),
      team_a_id: k("team", f.key, "a"),
      team_b_id: k("team", f.key, "b"),
      team_a_player_ids: pa.map((x) => k("player", f.key, "a", x)),
      team_b_player_ids: pb.map((x) => k("player", f.key, "b", x)),
      status: "scheduled",
    })),
  ),
);

process.stdout.write(`-- ${SLUG}\n${out.join("\n\n")}\n`);

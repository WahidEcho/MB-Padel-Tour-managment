/**
 * Builds the J200 Cairo 2026 (ITF World Tennis Tour Juniors, J-J200-EGY-2026-002,
 * 19–23 Oct 2026, supervisor Tarek Maher) as SQL: one tennis tournament holding
 * every draw (boys' and girls' singles and doubles) so the courts read as one
 * order of play, with the quarter-finals of Wednesday 21 October exactly as the
 * official order of play lists them.
 *
 * Draw positions, seeds and nationalities are the ITF's (itftennis.com draws, read
 * 21 Oct 2026); players with no nation play as neutral athletes. Times are Cairo
 * time. "Followed by" matches have no time and sit after the court's first match
 * (match_order); "After rest, NB 13:00, Court TBA" matches have 13:00 and no court.
 * Doubles rules (deciding point, match tie-break to 10) apply by themselves because
 * a doubles entry fields two players. The semi-finals are added when their order
 * of play is out.
 *
 *   npx tsx scripts/events/j200-cairo-2026.ts > j200-cairo-2026.sql
 *
 * Remove with: delete from tournaments where slug = 'j200-cairo-2026';
 */
import { DEFAULT_TENNIS_SCORING_CONFIG } from "../../src/lib/types";
import { nationByCode } from "../../src/lib/tennis/nations";
import { zonedToIso } from "../../src/lib/tennis/ties";

const k = (...parts: (string | number)[]) => `j200cai26:${parts.join(":")}`;
const isKey = (v: unknown): v is string => typeof v === "string" && v.startsWith("j200cai26:");
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

const SLUG = "j200-cairo-2026";
const DAY = "2026-10-21";
const COURTS = [1, 2, 5, 6, 7, 8, 9, 10];

/** [name, ITF nation or null for a neutral athlete] */
type Player = [string, string | null];
type Draw = "BS" | "GS" | "BD" | "GD";
const DRAW_NAME: Record<Draw, string> = { BS: "Boys' Singles", GS: "Girls' Singles", BD: "Boys' Doubles", GD: "Girls' Doubles" };

interface Entry {
  key: string;
  draw: Draw;
  players: Player[];
  seed: number | null;
}
interface Fixture {
  draw: Draw;
  /** Quarter-final in draw order, 1 (top) to 4. */
  qf: number;
  a: Entry;
  b: Entry;
  court: number | null;
  /** "10:00" / "13:00" in Cairo, or null for "followed by". */
  time: string | null;
}

const entries = new Map<string, Entry>();
function entry(draw: Draw, seed: number | null, ...players: Player[]): Entry {
  const key = `${draw}:${players.map(([n]) => n).join("/")}`;
  const e = entries.get(key) ?? { key, draw, players, seed };
  entries.set(key, e);
  return e;
}

// The order of play, row by row and court by court.
const FIXTURES: Fixture[] = [
  // Row 1: starting at 10:00
  { draw: "BS", qf: 4, court: 1, time: "10:00", a: entry("BS", null, ["Mohamed Genidy", "EGY"]), b: entry("BS", null, ["Filip Malis", "CAN"]) },
  { draw: "GS", qf: 4, court: 2, time: "10:00", a: entry("GS", 7, ["Carla Vazquez Alcudia", "ESP"]), b: entry("GS", 2, ["Ayse Bal", "TUR"]) },
  { draw: "GS", qf: 1, court: 5, time: "10:00", a: entry("GS", 1, ["Jahnie Van Zyl", "RSA"]), b: entry("GS", null, ["Ana Ioana Varsa", "ROU"]) },
  { draw: "BS", qf: 3, court: 6, time: "10:00", a: entry("BS", 5, ["Matisse Martin", "FRA"]), b: entry("BS", 4, ["Ken Ink", "EST"]) },
  { draw: "GS", qf: 3, court: 7, time: "10:00", a: entry("GS", 6, ["Anna Bazderova", null]), b: entry("GS", 4, ["Sara Oliveriusova", "CZE"]) },
  { draw: "GS", qf: 2, court: 8, time: "10:00", a: entry("GS", 3, ["Isabella Ruyu Yan", "CAN"]), b: entry("GS", null, ["Camilla Olga Castracani", "ITA"]) },
  { draw: "BS", qf: 1, court: 9, time: "10:00", a: entry("BS", null, ["Djordje Sapic", "SRB"]), b: entry("BS", null, ["Lilian Chidekh", "FRA"]) },
  { draw: "BS", qf: 2, court: 10, time: "10:00", a: entry("BS", null, ["Moritz Glauser", "LIE"]), b: entry("BS", null, ["Pablo Pradat", "FRA"]) },
  // Row 2: followed by
  {
    draw: "BD", qf: 2, court: 5, time: null,
    a: entry("BD", null, ["Nicolas Fays", "BEL"], ["Samy Iraqi", "MAR"]),
    b: entry("BD", null, ["Gabriel Niedermayr", "AUT"], ["Felix Raser", "AUT"]),
  },
  {
    draw: "GD", qf: 2, court: 6, time: null,
    a: entry("GD", 4, ["Megan Knight", "GBR"], ["Alisha Ndukwu", "POL"]),
    b: entry("GD", null, ["Grace Bernstein", "SWE"], ["Amy Shen", "CAN"]),
  },
  {
    draw: "BD", qf: 3, court: 7, time: null,
    a: entry("BD", null, ["Alexey Ilin", null], ["Praneel Sharma", "IND"]),
    b: entry("BD", null, ["Egor Navrazidi", null], ["Victor Pignaton", "BRA"]),
  },
  // Row 3: after rest, not before 13:00, court to be announced
  {
    draw: "BD", qf: 1, court: null, time: "13:00",
    a: entry("BD", 1, ["Oluwaseun Peter Ogunsakin", "NGR"], ["Ikenna Prosper Okonkwo", "NGR"]),
    b: entry("BD", null, ["Mohamed Genidy", "EGY"], ["Youssef Mourid", "EGY"]),
  },
  {
    draw: "GD", qf: 4, court: null, time: "13:00",
    a: entry("GD", null, ["Habiba Habib", "EGY"], ["Daania Daniella Hazli", "MAS"]),
    b: entry("GD", 2, ["Ayse Bal", "TUR"], ["Sara Oliveriusova", "CZE"]),
  },
  {
    draw: "GD", qf: 3, court: null, time: "13:00",
    a: entry("GD", null, ["Camilla Olga Castracani", "ITA"], ["Antonina Snochowska", "POL"]),
    b: entry("GD", 3, ["Anna Bazderova", null], ["Carla Vazquez Alcudia", "ESP"]),
  },
  {
    draw: "GD", qf: 1, court: null, time: "13:00",
    a: entry("GD", 1, ["Jahnie Van Zyl", "RSA"], ["Isabella Ruyu Yan", "CAN"]),
    b: entry("GD", null, ["Eva Kaliadina", null], ["Nikol Nuneva", "BUL"]),
  },
  {
    draw: "BD", qf: 4, court: null, time: "13:00",
    a: entry("BD", null, ["Luca Cosimi", "ITA"], ["Thomas Gunzinger", "SUI"]),
    b: entry("BD", null, ["Joseph Phitoussi", "FRA"], ["Pablo Pradat", "FRA"]),
  },
];

// Surnames of more than one word, as the ITF writes them.
const SURNAMES: Record<string, string> = { "Jahnie Van Zyl": "Van Zyl", "Carla Vazquez Alcudia": "Vazquez Alcudia" };
const surname = (name: string) => SURNAMES[name] ?? name.split(" ").slice(-1)[0];
function nationOf(e: Entry): { code: string | null; iso2: string | null } {
  const codes = [...new Set(e.players.map(([, c]) => c))];
  if (codes.length !== 1 || !codes[0]) return { code: null, iso2: null };
  const n = nationByCode(codes[0]);
  if (!n) throw new Error(`unknown nation ${codes[0]}`);
  return { code: n.code, iso2: n.iso2 };
}

function build() {
  for (const [, e] of entries) for (const [n, c] of e.players) if (c && !nationByCode(c)) throw new Error(`${n}: unknown nation ${c}`);
  const seen = new Set<string>();
  for (const f of FIXTURES) {
    const id = `${f.draw}${f.qf}`;
    if (seen.has(id)) throw new Error(`${id} twice`);
    seen.add(id);
  }
  if (seen.size !== 16) throw new Error(`16 quarter-finals expected, got ${seen.size}`);

  const T = k("tournament");
  insert("tournaments", [
    {
      id: T,
      name: "J200 Cairo 2026",
      slug: SLUG,
      sport: "tennis",
      kind: "tournament",
      status: "active",
      is_demo: false,
      public_access_enabled: false,
      created_by: "admin",
      city: "Cairo",
      timezone: "Africa/Cairo",
      starts_on: "2026-10-19",
      ends_on: "2026-10-23",
      scoring_config: { ...DEFAULT_TENNIS_SCORING_CONFIG, requireResultConfirmation: true },
      format_config: { type: "knockout", thirdPlaceMatch: false },
      branding_config: { holding: { title: "J200 Cairo 2026", message: "ITF World Tennis Tour Juniors" } },
    },
  ]);
  const courts = COURTS.map((n, i) => ({ id: k("court", n), tournament_id: T, court_name: `Court ${n}`, court_order: i + 1 }));
  insert("courts", courts);
  insert("screen_settings", [
    { tournament_id: T, screen_key: "main", screen_name: "Main", display_mode: "live", court_ids: courts.map((c) => c.id), focus_court_id: null },
  ]);

  const all = [...entries.values()];
  insert(
    "teams",
    all.map((e) => {
      const { code, iso2 } = nationOf(e);
      return {
        id: k("team", e.key),
        tournament_id: T,
        team_name: e.players.length === 1 ? e.players[0][0] : e.players.map(([n]) => surname(n)).join(" / "),
        nation_code: code,
        iso2,
        seed_number: e.seed,
        notes: DRAW_NAME[e.draw],
        check_in_status: "not_arrived",
        team_status: "active",
      };
    }),
  );
  insert(
    "players",
    all.flatMap((e) => e.players.map(([full_name], j) => ({ id: k("player", e.key, j), tournament_id: T, team_id: k("team", e.key), player_order: j + 1, full_name }))),
  );

  insert(
    "matches",
    FIXTURES.map((f, i) => {
      const at = f.time ? zonedToIso(`${DAY}T${f.time}`, "Africa/Cairo") : null;
      if (f.time && !at) throw new Error(`bad time ${f.time}`);
      return {
        id: k("match", f.draw, "QF", f.qf),
        tournament_id: T,
        stage: "quarter_final",
        round_name: `${DRAW_NAME[f.draw]} QF`,
        match_order: i + 1,
        court_id: f.court === null ? null : k("court", f.court),
        scheduled_time: at,
        team_a_id: k("team", f.a.key),
        team_b_id: k("team", f.b.key),
        status: "scheduled",
      };
    }),
  );
}

if (process.argv[1]?.endsWith("j200-cairo-2026.ts")) {
  build();
  process.stdout.write(`-- J200 Cairo 2026: ${SLUG}, order of play ${DAY}\nbegin;\n${out.join("\n\n")}\ncommit;\n`);
}

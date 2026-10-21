/**
 * Builds the two real events of the Cairo 2026 Junior Team Finals as SQL:
 *
 *   Davis Cup Junior Finals 2026 (boys)             · TV court: Court 1
 *   Billie Jean King Cup Junior Finals 2026 (girls) · TV court: Court 2
 *
 * Each event: tennis, nations team competition; 16 nations with their three
 * players and captain exactly as the ITF published them (Cairo 2026 Finals
 * Rules Guide, slides 5–7, from the ITF team announcements of October 2026);
 * its TV court and seven outside courts; the main screen and the TV court's
 * screen. Both start as drafts with the public pages off.
 *
 * Not in it, because nobody has it yet: seeds and groups (the draw in Cairo,
 * Reg 36) and each nation's order of merit. Players are stored in the ITF's
 * published order, which the ITF does not say is the order of merit: the desk
 * sets the real order on the Nations page before the first line-ups, since the
 * No. 1 singles must rank above the No. 2.
 *
 *   npx tsx scripts/events/cairo-2026.ts > cairo-2026.sql
 *
 * Remove with: delete from tournaments where slug in ('davis-cup-junior-finals-2026', 'bjk-cup-junior-finals-2026');
 */
import { DEFAULT_TENNIS_SCORING_CONFIG } from "../../src/lib/types";
import { newTournamentMatchDayRules } from "../../src/lib/matchday/rules";

/** Move Beyond, the organisation that runs both events (the live column's default too). */
const MOVE_BEYOND_ORG = "82e0bf4b-3c46-4d9a-ace9-76cffa9f8088";
import { nationByCode } from "../../src/lib/tennis/nations";

const k = (...parts: (string | number)[]) => `cairo26:${parts.join(":")}`;
const isKey = (v: unknown): v is string => typeof v === "string" && v.startsWith("cairo26:");
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

/** ITF code, players in the ITF's published order, captain. */
type Nation = [string, [string, string, string], string];

export const BOYS: Nation[] = [
  ["AUS", ["Taiki Takizawa", "Ethan Domingo", "Har Abir Sekhon"], "Andrew Roberts"],
  ["BRA", ["Livas Eduardo de Carvalho Damazio", "Henrique Pissette Vialle", "Victor Pignaton"], "Rodrigo Ferreiro"],
  ["CAN", ["Antoine Tardif", "Thomas O’Neill", "Marc-Edouard Lallier"], "Zacharias Ohlin"],
  ["CZE", ["Matyas Marsik", "Tommy Luxa", "Tobias Zapsky"], "Josef Cihak"],
  ["EGY", ["Mohamed Genidy", "Youssef Mourid", "Younis Mohamed Hussien Moawed"], "Yehia Elsallaly"],
  ["FRA", ["Pablo Pradat", "Benoit Geldof", "Joseph Phitoussi"], "Gregory Carraz"],
  ["HUN", ["Istvan Damjan Mokan", "Vencel Fazekas", "Mark Jony"], "Zoltan Nagy"],
  ["ITA", ["Zeno Roveri", "Daniele Longo", "Giorgio Ghia"], "Antonio Rubino"],
  ["IND", ["Tavish Pahwa", "Hruthik Katakam", "Ribhav Saroha"], "Rana Banerjee"],
  ["JPN", ["Takahiro Kawaguchi", "Shintaro Ogaki", "Junya Kawamura"], "Ko Iwamoto"],
  ["KAZ", ["Ansar Niyetkaliyev", "Akhmadi Makhanov", "Rodion Traigel"], "Sergey Kvak"],
  ["MAR", ["Reda El Aouni", "Samy Iraqi", "Mehdi Laabi"], "Mehdi Tahiri"],
  ["SRB", ["Pavle Stojiljkovic", "Igor Peric", "Luka Kostic"], "Ladislav Demeter"],
  ["ESP", ["Fernando Fontan Pardo de Santayana", "Toni Escarda Pineiro", "Ian Barroeta"], "Alejandro Aranega"],
  ["USA", ["Teodor Davidov", "Izyan Ahmad", "Tomas Laukys"], "Sylvain Guichard"],
  ["VEN", ["Javier Alejandro Sanchez Montoya", "Santiago Josue Gonzalez Rodriguez", "Andres Alfredo Sanchez Molina"], "Francisco Javier Lamas"],
];

export const GIRLS: Nation[] = [
  ["AUS", ["Tori Russell", "Ami Dalla Pozza", "Musemma Cilek"], "Tom George"],
  ["BRA", ["Maria Eduarda Carbone dos Santos", "Nathalia Tourinho", "Larissa Silenci"], "Maisa Feital"],
  ["CAN", ["Isabella Ruyu Yan", "Amy Shen", "Elisabeth Djaburian"], "Sharon Fichamn"],
  ["TPE", ["Chiang Yen-Ni", "Chiang Tsai-Jung", "Tsai Chen-Yun"], "Tsai Chung-Han"],
  ["CZE", ["Jana Kovackova", "Katerina Zajickova", "Ema Chladova"], "Pavlina Ticha"],
  ["COL", ["Emanuela Lares", "Laura Valentina Villamil Arias", "Alicia Londono"], "Carlos Andres Salamanca Caicedo"],
  ["EGY", ["Kenzy Ahmad Abdalaziz", "Fatima Rami Jamal Al-Deen", "Baher Karma"], "Ola Tarek"],
  ["GBR", ["Daniella Britton", "Megan Knight", "Annabel Wong"], "Katie O'Brien"],
  ["JPN", ["Ran Wakana", "Yui Komada", "Sakino Miyazawa"], "Jun Watanabe"],
  ["KOR", ["Sim Siyeon", "Kim Seohyeon", "Lee Yerin"], "Lim Yongkyu"],
  ["ROU", ["Maria-Valentina Pop", "Sara-Nicole Sitar", "Veronica Cervac"], "Ciprian Savulescu"],
  ["SVK", ["Laura Masarykova", "Viktoria Novakova", "Riana Rusnackova"], "Juraj Dulik"],
  ["ESP", ["Paola Pinera Celorio", "Ailish Garcia Fernandez", "Liliana Chetry Rodriguez"], "Julia Payola"],
  ["TUN", ["Selima Bendhia", "Emna Mathlouthi", "Sarah Boussaffir"], "Ahmed Noomene"],
  ["UKR", ["Polina Skliar", "Sofiia Bielinska", "Anna Shchavinska"], "Olga Bielinska"],
  ["USA", ["Jordyn Hazelitt", "Welles Newman", "Hannah Ayrault"], "David Secker"],
];

interface Event {
  key: string;
  name: string;
  slug: string;
  tvCourt: number;
  outside: number[];
  nations: Nation[];
}
export const EVENTS: Event[] = [
  { key: "boys", name: "Davis Cup Junior Finals 2026", slug: "davis-cup-junior-finals-2026", tvCourt: 1, outside: [3, 4, 5, 6, 7, 8, 9], nations: BOYS },
  { key: "girls", name: "Billie Jean King Cup Junior Finals 2026", slug: "bjk-cup-junior-finals-2026", tvCourt: 2, outside: [10, 11, 12, 13, 14, 15, 16], nations: GIRLS },
];

function build(ev: Event) {
  const T = k(ev.key, "tournament");
  insert("tournaments", [
    {
      id: T,
      name: ev.name,
      slug: ev.slug,
      sport: "tennis",
      kind: "tournament",
      status: "draft",
      is_demo: false,
      public_access_enabled: false,
      created_by: "admin",
      organization_id: MOVE_BEYOND_ORG,
      // As a tournament created in the admin: match day on.
      match_day_rules: newTournamentMatchDayRules("tennis"),
      scoring_config: { ...DEFAULT_TENNIS_SCORING_CONFIG, requireResultConfirmation: true },
      format_config: { type: "group_knockout", qualifyPerGroup: 2, thirdPlaceMatch: false, ties: {} },
      branding_config: {
        background: { url: "/backgrounds/night-clay.svg", kind: "svg", mime: "image/svg+xml", bytes: 8746, dim: "light", showOnPublic: false },
        holding: { title: "Junior Team Finals · Cairo 2026", message: ev.name },
      },
    },
  ]);
  const courts = [ev.tvCourt, ...ev.outside].map((n, i) => ({ id: k(ev.key, "court", n), tournament_id: T, court_name: `Court ${n}`, court_order: i + 1 }));
  insert("courts", courts);
  const tv = `court-${ev.tvCourt}-tv`;
  insert("screen_settings", [
    { tournament_id: T, screen_key: "main", screen_name: "Main", display_mode: "live", court_ids: courts.map((c) => c.id), focus_court_id: null },
    { tournament_id: T, screen_key: tv, screen_name: `Court ${ev.tvCourt} TV`, display_mode: "live", court_ids: [courts[0].id], focus_court_id: courts[0].id },
  ]);
  insert(
    "teams",
    ev.nations.map(([code, , captain]) => {
      const n = nationByCode(code);
      if (!n) throw new Error(`unknown nation ${code}`);
      return {
        id: k(ev.key, "team", code),
        tournament_id: T,
        team_name: n.name,
        nation_code: code,
        iso2: n.iso2,
        captain_name: captain,
        seed_number: null,
        check_in_status: "not_arrived",
        team_status: "active",
      };
    }),
  );
  insert(
    "players",
    ev.nations.flatMap(([code, players]) =>
      players.map((full_name, j) => ({ id: k(ev.key, "player", code, j), tournament_id: T, team_id: k(ev.key, "team", code), player_order: j + 1, full_name })),
    ),
  );
}

if (process.argv[1]?.endsWith("cairo-2026.ts")) {
  for (const ev of EVENTS) {
    if (ev.nations.length !== 16 || new Set(ev.nations.map((n) => n[0])).size !== 16) throw new Error(`${ev.name}: 16 nations expected`);
    build(ev);
  }
  process.stdout.write(`-- Cairo 2026 Junior Team Finals: ${EVENTS.map((e) => e.slug).join(", ")}\n${out.join("\n\n")}\n`);
}

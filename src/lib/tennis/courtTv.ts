/**
 * The court TV of a tennis team competition (the Cairo design): its organiser
 * settings, which break the wall shows and how long is left, and the small text
 * pieces every scene draws. Pure and framework-free.
 *
 * Breaks come only from what the system records:
 *
 * - a changeover, set break, warm-up, medical time-out or other break is a timer
 *   the referee's console records (TIMER_STARTED: `state.clock`, with the console's
 *   own start time), shown while the score it started at stands (liveClock);
 * - the 25 seconds between points is never recorded, so the wall counts it from the
 *   moment the score last moved on the server (the snapshot's `updated_at`), and only
 *   when the organiser runs the 25-second timer at all.
 *
 * Nothing here invents a time the system does not know: no recorded timer and no
 * fresh point means no break on the wall.
 */
import { clockText, liveClock, TIMERS, type TimerKind } from "../scoring/timing";
import type { ScoreState, TeamKey } from "../scoring/engine";
import type { CompletedSet, RubberType } from "../types";
import { isLogoSrc } from "../sponsors";

/* ---------------- organiser settings: branding_config.courtTv ---------------- */

export type CourtTvPalette = "forest" | "noir";
export const COURT_TV_PALETTES: { value: CourtTvPalette; label: string }[] = [
  { value: "forest", label: "Forest green (Davis Cup)" },
  { value: "noir", label: "Black and magenta (Billie Jean King Cup)" },
];

export interface CourtTvSettings {
  /** The score card lets the event background through, blurred. */
  glass: boolean;
  /** How solid the glass is, 25–90 (%). */
  glassOpacity: number;
  /** The sweep and the breathing ring behind a break. */
  breakAnimation: boolean;
  /** The countdown ring on a break and the 25 s shot clock. */
  breakTimer: boolean;
  /** The row of official break times under the score. */
  breakLegend: boolean;
  /** The match analytics when a rubber ends. */
  postMatchStats: boolean;
  /** The event's colours. */
  palette: CourtTvPalette;
}

export const COURT_TV_OPACITY = { min: 25, max: 90, step: 5 } as const;

export const DEFAULT_COURT_TV: CourtTvSettings = {
  glass: true,
  glassOpacity: 55,
  breakAnimation: true,
  breakTimer: true,
  breakLegend: true,
  postMatchStats: true,
  palette: "forest",
};

/** The stored settings, cleaned: anything missing or malformed is its default. */
export function sanitizeCourtTv(raw: unknown): CourtTvSettings {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const bool = (k: keyof CourtTvSettings) => (typeof r[k] === "boolean" ? (r[k] as boolean) : (DEFAULT_COURT_TV[k] as boolean));
  const op = typeof r.glassOpacity === "number" && Number.isFinite(r.glassOpacity) ? r.glassOpacity : DEFAULT_COURT_TV.glassOpacity;
  const stepped = Math.round(op / COURT_TV_OPACITY.step) * COURT_TV_OPACITY.step;
  return {
    glass: bool("glass"),
    glassOpacity: Math.min(COURT_TV_OPACITY.max, Math.max(COURT_TV_OPACITY.min, stepped)),
    breakAnimation: bool("breakAnimation"),
    breakTimer: bool("breakTimer"),
    breakLegend: bool("breakLegend"),
    postMatchStats: bool("postMatchStats"),
    palette: COURT_TV_PALETTES.some((p) => p.value === r.palette) ? (r.palette as CourtTvPalette) : DEFAULT_COURT_TV.palette,
  };
}

/** The card's alpha: the glass's opacity, or nearly solid without glass. */
export function cardAlpha(s: CourtTvSettings): number {
  return s.glass ? s.glassOpacity / 100 : 0.92;
}

/* ---------------- header: event logo and partner logos by theme ---------------- */

export { isLogoSrc };

export interface HeaderPartner {
  name: string;
  /** For a dark screen (usually a white logo). */
  logoUrl: string;
  /** For a light screen (a dark logo), when there is one. */
  logoLightUrl?: string;
  /** Width / height, for a box that is known before the file loads. */
  aspect?: number;
  /** How tall it is drawn on the 1920x1080 stage (16-96 px; 48 when unset). */
  height?: number;
}

export const MAX_HEADER_PARTNERS = 4;

/** branding_config.headerPartners, cleaned: valid logos only, at most four. */
export function sanitizeHeaderPartners(raw: unknown): HeaderPartner[] {
  if (!Array.isArray(raw)) return [];
  const out: HeaderPartner[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (!isLogoSrc(r.logoUrl)) continue;
    const aspect = typeof r.aspect === "number" && Number.isFinite(r.aspect) && r.aspect > 0.2 && r.aspect < 20 ? r.aspect : undefined;
    const height = typeof r.height === "number" && Number.isFinite(r.height) ? Math.round(Math.min(96, Math.max(16, r.height))) : undefined;
    out.push({
      name: typeof r.name === "string" ? r.name.trim().slice(0, 60) : "",
      logoUrl: r.logoUrl,
      ...(isLogoSrc(r.logoLightUrl) ? { logoLightUrl: r.logoLightUrl } : {}),
      ...(aspect ? { aspect } : {}),
      ...(height ? { height } : {}),
    });
    if (out.length >= MAX_HEADER_PARTNERS) break;
  }
  return out;
}

/** The partner's logo for this screen theme. */
export function partnerSrc(p: HeaderPartner, theme: "light" | "dark"): string {
  return theme === "light" && p.logoLightUrl ? p.logoLightUrl : p.logoUrl;
}

/**
 * The event logo for this screen theme: `eventLogoLightUrl` on a light screen when
 * there is one, else `eventLogoUrl`. Null when neither is a safe source.
 */
export function eventLogoFor(branding: { eventLogoUrl?: unknown; eventLogoLightUrl?: unknown } | null | undefined, theme: "light" | "dark"): string | null {
  const light = isLogoSrc(branding?.eventLogoLightUrl) ? branding!.eventLogoLightUrl : null;
  const base = isLogoSrc(branding?.eventLogoUrl) ? branding!.eventLogoUrl : null;
  return theme === "light" ? (light ?? base) : (base ?? light);
}

/* ---------------- breaks ---------------- */

export type BreakKind = "shot" | "changeover" | "set_break" | "warmup" | "medical" | "other";

/** The official break times on the legend, in seconds (ITF Rule 29a; warm-up and medical time-out as the console runs them). */
export const OFFICIAL_BREAKS: { kind: Exclude<BreakKind, "other">; label: string; seconds: number }[] = [
  { kind: "shot", label: "Between points", seconds: TIMERS.between_points.limit! },
  { kind: "changeover", label: "Changeover", seconds: TIMERS.changeover.limit! },
  { kind: "set_break", label: "Set break", seconds: TIMERS.set_break.limit! },
  { kind: "warmup", label: "Warm-up", seconds: TIMERS.warmup.limit! },
  { kind: "medical", label: "Medical", seconds: TIMERS.medical.limit! },
];

/** "25 s", "90 s", "5 min". */
export function breakLength(seconds: number): string {
  return seconds >= 180 && seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
}

export interface BreakView {
  kind: BreakKind;
  /** The timer's own label ("Bathroom break" for an "other" break). */
  label: string;
  /** Seconds allowed; null for an open stopwatch. */
  total: number | null;
  /** Milliseconds since it started (from the recorded start, or the score's last move). */
  elapsedMs: number;
  /** Whose break, when it is one side's (medical, bathroom). */
  team: TeamKey | null;
}

/** How long the 25 s shot clock stays on after the score last moved. */
export const SHOT_CLOCK_SECONDS = TIMERS.between_points.limit!;

/**
 * The break the wall shows for a live match, or null.
 *
 * `scoreMovedAt`: when the score last moved on the server (the snapshot's
 * updated_at). `shotClock`: the organiser runs the 25-second timer. A recorded
 * timer always wins over the shot clock.
 */
export function breakScene(
  state: ScoreState | null | undefined,
  scoreMovedAt: string | null | undefined,
  now: number,
  opts: { shotClock: boolean },
): BreakView | null {
  if (!state || state.matchOver) return null;
  const c = liveClock(state, now);
  if (c) {
    const kind: BreakKind =
      c.kind === "changeover" || c.kind === "set_break" || c.kind === "warmup" || c.kind === "medical" ? c.kind : "other";
    const started = Date.parse(c.startedAt);
    return { kind, label: TIMERS[c.kind as TimerKind].label, total: c.limit, elapsedMs: Math.max(0, now - started), team: c.team };
  }
  if (!opts.shotClock || !scoreMovedAt || state.clock) return null;
  // Before the first point there is nothing to count from.
  const played =
    state.completedSets.length > 0 ||
    state.teamA.games + state.teamB.games > 0 ||
    state.teamA.points !== "0" ||
    state.teamB.points !== "0" ||
    state.teamA.tiebreakPoints + state.teamB.tiebreakPoints > 0;
  if (!played) return null;
  const moved = Date.parse(scoreMovedAt);
  if (!Number.isFinite(moved)) return null;
  const elapsed = now - moved;
  // A little clock skew is forgiven; a stale score is not a running clock.
  if (elapsed < -2_000 || elapsed >= SHOT_CLOCK_SECONDS * 1000) return null;
  return { kind: "shot", label: TIMERS.between_points.label, total: SHOT_CLOCK_SECONDS, elapsedMs: Math.max(0, elapsed), team: null };
}

export interface Countdown {
  /** Whole seconds left (0 once over). */
  remaining: number;
  /** "1:25", "25" for the shot clock (under a minute, no minutes), "+0:12" when over. */
  text: string;
  /** 0..1 of the ring still to run. */
  left: number;
  over: boolean;
}

/** A countdown from `total` seconds after `elapsedMs`. Counts up past zero as "+m:ss". */
export function countdown(total: number, elapsedMs: number, opts: { seconds?: boolean } = {}): Countdown {
  const elapsed = Math.max(0, Math.floor(elapsedMs / 1000));
  const remaining = Math.max(0, total - elapsed);
  const over = elapsed > total;
  const text = over ? `+${clockText(elapsed - total)}` : opts.seconds ? String(remaining) : clockText(remaining);
  return { remaining, text, left: total > 0 ? Math.max(0, Math.min(1, (total * 1000 - elapsedMs) / (total * 1000))) : 0, over };
}

/** "After game 3 · Set 2" for the changeover that follows the current score. */
export function changeoverWhat(state: ScoreState): string {
  return `After game ${state.teamA.games + state.teamB.games} · Set ${state.currentSet}`;
}

/** "After set 1 · Egypt lead 6–4" (or "level"), from the set just finished. */
export function setBreakWhat(sets: CompletedSet[], nameA: string, nameB: string): string {
  const last = sets[sets.length - 1];
  if (!last) return "";
  const a = sets.filter((x) => x.teamAGames > x.teamBGames).length;
  const b = sets.length - a;
  const score = `${Math.max(last.teamAGames, last.teamBGames)}–${Math.min(last.teamAGames, last.teamBGames)}`;
  const who = last.teamAGames > last.teamBGames ? nameA : nameB;
  const lead = a === b ? `Sets level ${a}–${b}` : `${a > b ? nameA : nameB} lead ${Math.max(a, b)}–${Math.min(a, b)} in sets`;
  return sets.length === 1 ? `After set 1 · ${who} lead ${score}` : `After set ${sets.length} · ${who} take it ${score} · ${lead}`;
}

/* ---------------- text pieces ---------------- */

export const RUBBER_NAMES: Record<RubberType, string> = { S1: "Singles 1", S2: "Singles 2", D: "Doubles" };

export function rubberName(no: number, type: RubberType): string {
  return `Rubber ${no} · ${RUBBER_NAMES[type]}`;
}

/** "Best of 3 sets" / "Best of 3 · match tie-break" (+ "· no-ad"). */
export function formatLine(rules: { setsToWinMatch: number; matchTiebreak?: boolean; decidingPoint?: boolean }): string {
  const best = Math.max(1, rules.setsToWinMatch * 2 - 1);
  return [rules.matchTiebreak ? `Best of ${best} · match tie-break` : `Best of ${best} sets`, rules.decidingPoint ? "No-ad" : ""].filter(Boolean).join(" · ");
}

/** The match clock while it runs: "0:52", "1:18" (hours and minutes). */
export function matchClock(startedAt: string | null | undefined, now: number): string | null {
  if (!startedAt) return null;
  const t = Date.parse(startedAt);
  if (!Number.isFinite(t) || now < t) return null;
  const m = Math.floor((now - t) / 60_000);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

/** A set's label: "Set 2", or "Tie-break" for a match tie-break in place of a set. */
export function setLabel(i: number, matchTiebreak: boolean): string {
  return matchTiebreak ? "Tie-break" : `Set ${i + 1}`;
}

/** The score from the winner's side: "6–4 3–6 [10–7]". */
export function scoreFrom(sets: CompletedSet[], side: TeamKey): string {
  return sets
    .map((x) => {
      const [m, t] = side === "A" ? [x.teamAGames, x.teamBGames] : [x.teamBGames, x.teamAGames];
      if (x.matchTiebreak && x.tiebreak) {
        const [p, q] = side === "A" ? [x.tiebreak.a, x.tiebreak.b] : [x.tiebreak.b, x.tiebreak.a];
        return `[${p}–${q}]`;
      }
      return `${m}–${t}`;
    })
    .join(" ");
}

/** Initial of the first name(s) and the surname: "Kenzy Ahmad Abdalaziz" → "K. A. Abdalaziz". */
export function shortName(full: string): string {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] ?? "";
  return `${parts.slice(0, -1).map((p) => `${p[0]}.`).join(" ")} ${parts[parts.length - 1]}`;
}

/** A stat line's value split for the wall: "70%" big and "39/56" small, or a plain count. */
export function statCell(text: string): { big: string; small: string | null } {
  const m = text.match(/^(\d+\/\d+) · (\d+%)$/);
  return m ? { big: m[2], small: m[1] } : { big: text, small: null };
}

/* ---------------- each player's record at the event ---------------- */

export interface EventRecord {
  matches: [number, number];
  sets: [number, number];
  games: [number, number];
}

export interface RecordRubber {
  status: string;
  winner_team_id: string | null;
  team_a_id: string | null;
  a: string[];
  b: string[];
  sets: CompletedSet[];
}

const FINISHED = ["completed", "walkover", "retired", "disqualified"];

/**
 * Won–lost in matches, sets and games across the finished rubbers (singles and
 * doubles). A match tie-break counts as a set and one game, as it is recorded.
 */
export function eventRecords(rubbers: RecordRubber[]): Record<string, EventRecord> {
  const out: Record<string, EventRecord> = {};
  for (const r of rubbers) {
    if (!FINISHED.includes(r.status) || !r.winner_team_id) continue;
    const aWon = r.winner_team_id === r.team_a_id;
    const setsA = r.sets.filter((x) => (x.matchTiebreak && x.tiebreak ? x.tiebreak.a > x.tiebreak.b : x.teamAGames > x.teamBGames)).length;
    const setsB = r.sets.length - setsA;
    const gA = r.sets.reduce((n, x) => n + x.teamAGames, 0);
    const gB = r.sets.reduce((n, x) => n + x.teamBGames, 0);
    const add = (id: string, won: boolean, s: [number, number], g: [number, number]) => {
      const rec = (out[id] ??= { matches: [0, 0], sets: [0, 0], games: [0, 0] });
      rec.matches[won ? 0 : 1]++;
      rec.sets[0] += s[0];
      rec.sets[1] += s[1];
      rec.games[0] += g[0];
      rec.games[1] += g[1];
    };
    for (const id of r.a) add(id, aWon, [setsA, setsB], [gA, gB]);
    for (const id of r.b) add(id, !aWon, [setsB, setsA], [gB, gA]);
  }
  return out;
}

/** "Egypt win the tie 3–0", "Tie level · the doubles decides", "Egypt lead 1–0". */
export function tieStatus(score: [number, number], nameA: string, nameB: string, opts: { rubbers: number; decided: boolean }): string {
  const [a, b] = score;
  const need = Math.floor(opts.rubbers / 2) + 1;
  const left = opts.rubbers - a - b;
  if (a >= need || b >= need) {
    const w = a > b ? nameA : nameB;
    return left > 0 && !opts.decided ? `${w} win the tie · ${left === 1 ? "the last rubber is" : "the other rubbers are"} still played` : `${w} win the tie ${Math.max(a, b)}–${Math.min(a, b)}`;
  }
  if (a === b) return left === 1 ? "Tie level · the last rubber decides" : `Tie level ${a}–${b}`;
  return `${a > b ? nameA : nameB} lead ${Math.max(a, b)}–${Math.min(a, b)}`;
}

/* ---------------- the admin form ---------------- */

/** The part of FormData the parser reads (so tests can pass a plain FormData). */
export interface FormLike {
  get(name: string): unknown;
  getAll(name: string): unknown[];
}

export interface CourtTvForm {
  settings: CourtTvSettings;
  /** "" clears it. */
  eventLogoLightUrl: string;
  partners: HeaderPartner[];
  problems: string[];
}

const ticked = (f: FormLike, k: string) => f.getAll(k).map(String).includes("on");
const field = (f: FormLike, k: string, max = 1000) => String(f.get(k) ?? "").trim().slice(0, max);

/**
 * Admin → Screens → Court TV design. Each switch rides with a hidden "off", so an
 * unticked box is written too. Logos are typed as a site path or an https URL;
 * anything else is refused by name rather than dropped silently.
 */
export function courtTvFromForm(f: FormLike): CourtTvForm {
  const problems: string[] = [];
  const settings = sanitizeCourtTv({
    glass: ticked(f, "glass"),
    glassOpacity: Number(field(f, "glass_opacity", 4)),
    breakAnimation: ticked(f, "break_animation"),
    breakTimer: ticked(f, "break_timer"),
    breakLegend: ticked(f, "break_legend"),
    postMatchStats: ticked(f, "post_match_stats"),
    palette: field(f, "palette", 20),
  });
  const light = field(f, "event_logo_light_url");
  if (light && !isLogoSrc(light)) problems.push("The light-screen event logo must be a site path (/sponsors/…) or an https link.");
  const partners: HeaderPartner[] = [];
  for (let i = 0; i < MAX_HEADER_PARTNERS; i++) {
    const logo = field(f, `partner_logo_${i}`);
    const lightLogo = field(f, `partner_light_${i}`);
    const name = field(f, `partner_name_${i}`, 60);
    if (!logo && !lightLogo && !name) continue;
    if (!isLogoSrc(logo)) {
      problems.push(`Partner ${i + 1}: the logo must be a site path (/sponsors/…) or an https link.`);
      continue;
    }
    if (lightLogo && !isLogoSrc(lightLogo)) {
      problems.push(`Partner ${i + 1}: the light-screen logo must be a site path or an https link.`);
      continue;
    }
    const num = (k: string) => {
      const v = Number(field(f, k, 8));
      return field(f, k, 8) && Number.isFinite(v) && v > 0 ? v : undefined;
    };
    partners.push(
      ...sanitizeHeaderPartners([{ name, logoUrl: logo, logoLightUrl: lightLogo || undefined, aspect: num(`partner_aspect_${i}`), height: num(`partner_height_${i}`) }]),
    );
  }
  return { settings, eventLogoLightUrl: light && isLogoSrc(light) ? light : "", partners, problems };
}

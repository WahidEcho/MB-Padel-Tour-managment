/**
 * Smash import, the plan: which finished Smash matches become a Move Score final result, and which
 * go to the desk. Pure (no Node, browser or Next.js APIs); the server runner (server.ts) reads both
 * sides, calls planImport and enters each result through the one write path (scoring/append.ts).
 *
 * Rules that always hold:
 *   - Courts 13 and 14 (scored point by point by our chair umpires) are never imported.
 *   - Only a rubber with no score at all on Move Score (scheduled or ready, last event 0, no score
 *     event) gets a result; anything scored, live or finished here is skipped.
 *   - Smash publishes no tie-break points (null or 0-0): the set's winner takes the tie-break 7-5
 *     (owner, 2 Nov 2026: the winner is what is announced).
 *   - The desk gets retirements, walkovers, abandoned matches, a winner the sets do not give, a
 *     line-up or a doubles pair that differs from ours, and a Smash match with no single matching tie.
 *
 * Mapping: same court name ("Court N"), same Cairo day, same two nation codes → our tie; doubles →
 * the tie's D rubber (pair checked), singles → the S1/S2 rubber whose line-up names match. Sets are
 * turned round when Smash's player 1 is our side B, and a match tie-break Smash writes as its points
 * ([10, 6]) is entered as one (`matchTiebreakSet`).
 */
import { scoringConfigForMatch } from "../scoring/rules";
import { buildResultState } from "../scoring/resultEntry";
import { matchTiebreakSet, setKindAt, type EnteredSet } from "../scoring/finalScore";
import type { MatchRules, Stage } from "../types";
import { cairoDay, type SmashLiveScore, type SmashMatch, type SmashSchedule } from "./feed";
import type { ScoreState } from "../scoring/engine";

/** Scored on Move Score by our own chair umpires: never imported. */
export const OWN_COURTS: ReadonlySet<number> = new Set([13, 14]);
/** The two Cairo events (Nov 2026). */
export const SMASH_EVENT_SLUGS = ["davis-cup-junior-finals-2026", "bjk-cup-junior-finals-2026"] as const;

/* ---------------- our side, as the server reads it ---------------- */

export interface OurEvent {
  id: string;
  slug: string;
  sport: string | null;
  scoring_config: unknown;
}
export interface OurCourt {
  id: string;
  tournamentId: string;
  name: string;
}
export interface OurTeam {
  id: string;
  tournamentId: string;
  code: string | null;
}
export interface OurPlayer {
  id: string;
  teamId: string;
  name: string;
}
export interface OurTie {
  id: string;
  tournamentId: string;
  courtId: string | null;
  scheduledTime: string | null;
  teamA: string | null;
  teamB: string | null;
  roundName: string | null;
}
export interface OurRubber {
  id: string;
  tournamentId: string;
  tieId: string;
  rubberType: string | null;
  stage: string;
  status: string;
  teamA: string | null;
  teamB: string | null;
  aPlayerIds: string[] | null;
  bPlayerIds: string[] | null;
  /** match_score_snapshots.last_event_number (0 without a snapshot). */
  lastEventNumber: number;
  /** Any score_events row for the match at all. */
  hasEvents: boolean;
  /** Its score so far is Smash's live score mirrored here (snapshot `source: "smash"`), nobody's points. */
  mirrored?: boolean;
}
export interface OurSide {
  events: OurEvent[];
  courts: OurCourt[];
  teams: OurTeam[];
  players: OurPlayer[];
  ties: OurTie[];
  rubbers: OurRubber[];
}

/* ---------------- the plan ---------------- */

export interface PlanItem {
  court: number;
  smashId: string;
  /** "singles #1: Name (EGY) v Name (SRB)". */
  smash: string;
  /** "DC Group A EGY v SRB S1", once the rubber is known. */
  ours: string | null;
  why: string;
}
export interface PlanEntry extends PlanItem {
  matchId: string;
  tournamentId: string;
  payload: { sets: EnteredSet[] };
  winnerTeamId: string;
}
export interface ImportPlan {
  enter: PlanEntry[];
  desk: PlanItem[];
  skipped: PlanItem[];
}

/** Lower case, no accents, letters only: "Thomas O'NEILL" → "neill o thomas" (word order ignored). */
export function nameKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .sort()
    .join(" ");
}

const sameNames = (smash: string[], ours: string[]) => {
  if (smash.length === 0 || smash.length !== ours.length) return false;
  const a = smash.map(nameKey).sort();
  const b = ours.map(nameKey).sort();
  return a.every((k, i) => k !== "" && k === b[i]);
};

const smashLabel = (m: SmashMatch) =>
  `${m.type} #${m.order}: ${m.sides.map((s) => `${s.names.join(" / ")} (${s.code})`).join(" v ")}`;

const scoreLine = (sets: EnteredSet[]) =>
  sets.map((s) => (s.tb && s.a + s.b <= 1 ? `[${s.tb.a}-${s.tb.b}]` : `${s.a}-${s.b}${s.tb ? `(${Math.min(s.tb.a, s.tb.b)})` : ""}`)).join(" ");

/** The rules a rubber is played under, as the server resolves them (resultContext). */
export function rubberRules(event: OurEvent, rubber: Pick<OurRubber, "id" | "stage" | "rubberType">): MatchRules {
  return scoringConfigForMatch(
    { scoring_config: (event.scoring_config ?? {}) as never, sport: event.sport ?? undefined },
    { stage: rubber.stage as Stage, id: rubber.id },
    null,
    { doubles: rubber.rubberType === "D" },
  ) as MatchRules;
}

/** A set that can only have ended in a tie-break (7-6 under the usual rules). */
function isTiebreakSet(rules: MatchRules, x: number, y: number): boolean {
  const w = Math.max(x, y);
  const l = Math.min(x, y);
  if (w === 7 && l === 6) return true;
  const at = rules.tiebreakAtGames ?? rules.gamesToWinSet;
  return Boolean(rules.tiebreakEnabled) && w === at + 1 && l === at;
}

/**
 * Smash's sets, from our side A, as the result form takes them; or why they cannot be entered
 * without a person.
 */
export function enteredSets(m: SmashMatch, aIsP1: boolean, rules: MatchRules): { ok: true; sets: EnteredSet[] } | { ok: false; why: string } {
  if (m.sets.length === 0) return { ok: false, why: "no readable score on Smash" };
  const out: EnteredSet[] = [];
  for (const [i, raw] of m.sets.entries()) {
    const [x, y] = aIsP1 ? raw : [raw[1], raw[0]];
    const t = m.tiebreaks[i];
    const tb = t ? (aIsP1 ? { a: t[0], b: t[1] } : { a: t[1], b: t[0] }) : null;
    if (setKindAt(rules, out) === "match_tiebreak") {
      // Smash writes a match tie-break as its points ([10, 6]); or as a set with its points beside it.
      if (Math.max(x, y) >= 7 && x !== y) out.push(matchTiebreakSet(x, y));
      else if (tb && tb.a !== tb.b && Math.max(tb.a, tb.b) >= 7) out.push(matchTiebreakSet(tb.a, tb.b));
      else return { ok: false, why: `set ${i + 1} is a match tie-break here, but Smash gives no tie-break points (${raw[0]}-${raw[1]})` };
      continue;
    }
    if (isTiebreakSet(rules, x, y)) {
      // Smash publishes no tie-break points (null or 0-0). Owner, 2 Nov 2026: announce the winner,
      // so the set's winner takes the tie-break 7-5 (the games, the set and the match stay right).
      if (!tb || (tb.a === 0 && tb.b === 0)) {
        out.push({ a: x, b: y, tb: x > y ? { a: 7, b: 5 } : { a: 5, b: 7 } });
        continue;
      }
      if (tb.a === tb.b || tb.a > tb.b !== x > y) return { ok: false, why: `set ${i + 1}: the tie-break points (${t![0]}-${t![1]}) do not give the set's winner` };
      out.push({ a: x, b: y, tb });
      continue;
    }
    // Tie-break points on a set that was not a tie-break mean nothing: never sent.
    out.push({ a: x, b: y });
  }
  return { ok: true, sets: out };
}

/**
 * Whether our officials have this rubber: started, scored or finished here by anyone but the Smash
 * mirror. The reason, or null when the importer may write it.
 */
export function officialsTouched(r: Pick<OurRubber, "status" | "lastEventNumber" | "hasEvents" | "mirrored">): string | null {
  const open = r.status === "scheduled" || r.status === "ready" || (r.status === "live" && r.mirrored === true);
  if (!open) return `already ${r.status} on Move Score`;
  if (r.lastEventNumber > 0 || r.hasEvents) return "already has a score on Move Score";
  return null;
}

type Located =
  | { ok: true; rubber: OurRubber; tie: OurTie; event: OurEvent | undefined; label: string; aIsP1: boolean; fits: (r: OurRubber) => boolean }
  | { ok: false; why: string; label: string | null };

/**
 * The rubber a Smash match is: same court name, same Cairo day, same two nations → our tie; doubles
 * → its D rubber, singles → the S1/S2 rubber whose line-up names match Smash's players.
 */
export function locateRubber(m: SmashMatch, ours: OurSide): Located {
  const teams = new Map(ours.teams.map((t) => [t.id, t]));
  const events = new Map(ours.events.map((e) => [e.id, e]));
  const playerName = new Map(ours.players.map((p) => [p.id, p.name]));
  const short = (tid: string) => (events.get(tid)?.slug.startsWith("bjk") ? "BJK" : events.get(tid)?.slug.startsWith("davis") ? "DC" : (events.get(tid)?.slug ?? "?"));
  const code = (teamId: string | null) => (teamId ? (teams.get(teamId)?.code ?? "").toUpperCase() : "");
  const no = (why: string, label: string | null = null): Located => ({ ok: false, why, label });

  const courtName = `court ${m.court}`;
  const courtIds = new Set(ours.courts.filter((c) => c.name.trim().toLowerCase() === courtName).map((c) => c.id));
  if (courtIds.size === 0) return no(`Court ${m.court} is in neither event`);
  const [p1, p2] = m.sides;
  const nations = (t: OurTie) => {
    const codes = [code(t.teamA), code(t.teamB)];
    return p1.code !== p2.code && codes.includes(p1.code) && codes.includes(p2.code);
  };
  const onCourt = ours.ties.filter((t) => t.courtId && courtIds.has(t.courtId) && nations(t));
  const sameDay = m.day ? onCourt.filter((t) => t.scheduledTime && cairoDay(Date.parse(t.scheduledTime)) === m.day) : onCourt;
  if (sameDay.length !== 1) {
    return no(
      sameDay.length === 0
        ? `no ${p1.code} v ${p2.code} tie on Court ${m.court}${m.day ? ` on ${m.day}` : ""}`
        : `${sameDay.length} ${p1.code} v ${p2.code} ties on Court ${m.court}: pick by hand`,
    );
  }
  const tie = sameDay[0];
  const event = events.get(tie.tournamentId);
  const rubbers = ours.rubbers.filter((r) => r.tieId === tie.id);
  const names = (ids: string[] | null) => (ids ?? []).map((id) => playerName.get(id) ?? "");
  const sideOf = (teamId: string | null) => (code(teamId) === p1.code ? p1 : code(teamId) === p2.code ? p2 : null);
  const fits = (r: OurRubber) => {
    const a = sideOf(r.teamA);
    const b = sideOf(r.teamB);
    return !!a && !!b && a !== b && sameNames(a.names, names(r.aPlayerIds)) && sameNames(b.names, names(r.bPlayerIds));
  };
  const tieLabel = `${short(tie.tournamentId)} ${tie.roundName ?? "tie"} ${code(tie.teamA)} v ${code(tie.teamB)}`;
  let rubber: OurRubber | undefined;
  if (m.type === "doubles") {
    const ds = rubbers.filter((r) => r.rubberType === "D");
    if (ds.length !== 1) return no(`no single doubles rubber in ${tieLabel}`);
    rubber = ds[0];
  } else {
    const ss = rubbers.filter((r) => r.rubberType !== "D" && fits(r));
    if (ss.length !== 1) {
      return no(ss.length === 0 ? `no singles rubber in ${tieLabel} with these players (line-up differs or not named?)` : `more than one singles rubber fits in ${tieLabel}`);
    }
    rubber = ss[0];
  }
  const label = `${tieLabel} ${rubber.rubberType ?? ""}`.trim();
  return { ok: true, rubber, tie, event, label, aIsP1: code(rubber.teamA) === p1.code, fits };
}

/**
 * What to do with each finished Smash match. Matches not yet finished on Smash are not listed.
 * `ownCourts` is for tests only; the server always uses OWN_COURTS.
 */
export function planImport(smash: SmashSchedule, ours: OurSide, opts: { ownCourts?: ReadonlySet<number> } = {}): ImportPlan {
  const own = opts.ownCourts ?? OWN_COURTS;
  const plan: ImportPlan = { enter: [], desk: [], skipped: [] };

  for (const m of smash.matches) {
    if (m.status !== "completed") continue;
    const base = { court: m.court, smashId: m.id, smash: smashLabel(m), ours: null as string | null };
    const desk = (why: string, label: string | null = null) => plan.desk.push({ ...base, ours: label, why });
    const skip = (why: string, label: string | null = null) => plan.skipped.push({ ...base, ours: label, why });

    if (own.has(m.court)) {
      skip("court scored on Move Score");
      continue;
    }
    const found = locateRubber(m, ours);
    if (!found.ok) {
      desk(found.why, found.label);
      continue;
    }
    const { rubber, event, label, fits } = found;

    // Anything already on Move Score is the officials' and stays as it is (Smash's own live
    // score mirrored here is not: the result replaces it).
    const touched = officialsTouched(rubber);
    if (touched) {
      skip(touched, label);
      continue;
    }
    if (m.type === "doubles" && !fits(rubber)) {
      desk("doubles pair differs from our line-up (or not named yet)", label);
      continue;
    }
    if (m.retired || m.walkover || m.abandoned) {
      desk(`${m.retired ? "retired" : m.walkover ? "walkover" : "abandoned"} on Smash: enter by hand`, label);
      continue;
    }
    if (!event || !rubber.teamA || !rubber.teamB) {
      desk("both sides must be known on Move Score", label);
      continue;
    }
    const aIsP1 = found.aIsP1;
    const rules = rubberRules(event, rubber);
    const sets = enteredSets(m, aIsP1, rules);
    if (!sets.ok) {
      desk(sets.why, label);
      continue;
    }
    const built = buildResultState({ engine: "games", rules, payload: { sets: sets.sets } });
    if (!built.ok) {
      desk(`not a finished score under our rules: ${built.problems.map((p) => p.message).join("; ")}`, label);
      continue;
    }
    if (m.winner === null) {
      desk("Smash names no winner", label);
      continue;
    }
    if ((built.winner === "A") !== ((m.winner === 1) === aIsP1)) {
      desk("the winner Smash names does not match the sets: check by hand", label);
      continue;
    }
    plan.enter.push({
      ...base,
      ours: label,
      why: scoreLine(sets.sets),
      matchId: rubber.id,
      tournamentId: rubber.tournamentId,
      payload: { sets: sets.sets },
      winnerTeamId: built.winner === "A" ? rubber.teamA : rubber.teamB,
    });
  }

  // Two Smash matches on one rubber: neither is entered.
  const count = new Map<string, number>();
  for (const e of plan.enter) count.set(e.matchId, (count.get(e.matchId) ?? 0) + 1);
  const twice = plan.enter.filter((e) => (count.get(e.matchId) ?? 0) > 1);
  if (twice.length) {
    plan.enter = plan.enter.filter((e) => (count.get(e.matchId) ?? 0) === 1);
    for (const e of twice) plan.desk.push({ court: e.court, smashId: e.smashId, smash: e.smash, ours: e.ours, why: "two Smash matches map to this rubber: check by hand" });
  }
  return plan;
}

/* ---------------- live scores ---------------- */

/** Marks a score state as Smash's live score mirrored here (never a referee's points). */
export const MIRROR_SOURCE = "smash";

export interface LiveEntry {
  court: number;
  smashId: string;
  matchId: string;
  tournamentId: string;
  ours: string;
  /** "2-6 3-1 30-40": the score written. */
  line: string;
  state: ScoreState & { source: typeof MIRROR_SOURCE; smashId: string };
}
export interface LivePlan {
  update: LiveEntry[];
  desk: PlanItem[];
  skipped: PlanItem[];
}

const POINT_LABELS = ["0", "15", "30", "40", "AD"] as const;
type Point = (typeof POINT_LABELS)[number];
const asPoint = (p: string): Point => ((POINT_LABELS as readonly string[]).includes(p) ? (p as Point) : "0");

/**
 * Smash's score in play as our score state, from our side A: finished sets, the games of the set in
 * play, the game score (or tie-break points) and the server. Null when the numbers make no sense.
 */
export function liveState(score: SmashLiveScore, aIsP1: boolean, smashId: string): LiveEntry["state"] | null {
  const flip = <T,>(x: [T, T]): [T, T] => (aIsP1 ? x : [x[1], x[0]]);
  const done = score.setsWon[0] + score.setsWon[1];
  if (done > score.sets.length || done > 4) return null;
  const finished = score.sets.slice(0, done).map((x) => flip(x));
  const current = flip(score.sets[done] ?? [0, 0]);
  if ([...finished.flat(), ...current].some((g) => g < 0 || g > 30)) return null;
  const [setsA, setsB] = flip(score.setsWon);
  const tiebreak = score.tiebreak || score.matchTiebreak;
  const [ptA, ptB] = flip(score.points);
  const [tbA, tbB] = flip(score.tiebreakPoints);
  const serving = score.serving === null ? null : (score.serving === 1) === aIsP1 ? "A" : "B";
  return {
    currentSet: done + 1,
    teamA: { points: tiebreak ? "0" : asPoint(ptA), games: current[0], sets: setsA, tiebreakPoints: tiebreak ? tbA : 0 },
    teamB: { points: tiebreak ? "0" : asPoint(ptB), games: current[1], sets: setsB, tiebreakPoints: tiebreak ? tbB : 0 },
    isTiebreak: tiebreak,
    ...(score.matchTiebreak ? { isMatchTiebreak: true } : {}),
    completedSets: finished.map(([x, y]) => ({ teamAGames: x, teamBGames: y })),
    // The screens draw the serve dot from servingTeam, which a tie-break leaves null.
    servingTeam: tiebreak ? null : serving,
    tiebreakFirstServer: null,
    winner: null,
    matchOver: false,
    source: MIRROR_SOURCE,
    smashId,
  };
}

const liveLine = (st: ScoreState) => {
  const sets = st.completedSets.map((x) => `${x.teamAGames}-${x.teamBGames}`);
  sets.push(`${st.teamA.games}-${st.teamB.games}`);
  const pts = st.isTiebreak ? `[${st.teamA.tiebreakPoints}-${st.teamB.tiebreakPoints}]` : `${st.teamA.points}-${st.teamB.points}`;
  return `${sets.join(" ")} ${pts}`;
};

/**
 * Which of our rubbers take Smash's live score now: every Smash match in play off our own courts
 * that maps to one rubber our officials have not touched (scheduled, ready, or live from this
 * mirror; no score event of anyone's). Singles need Smash's player, doubles Smash's pair, to be our
 * line-up for that rubber; otherwise the desk is told.
 */
export function planLive(smash: SmashSchedule, live: Map<string, SmashLiveScore>, ours: OurSide, opts: { ownCourts?: ReadonlySet<number> } = {}): LivePlan {
  const own = opts.ownCourts ?? OWN_COURTS;
  const plan: LivePlan = { update: [], desk: [], skipped: [] };
  for (const m of smash.matches) {
    const score = live.get(m.id);
    if (m.status !== "live" || !score) continue;
    const base = { court: m.court, smashId: m.id, smash: smashLabel(m), ours: null as string | null };
    if (own.has(m.court)) {
      plan.skipped.push({ ...base, why: "court scored on Move Score" });
      continue;
    }
    const found = locateRubber(m, ours);
    if (!found.ok) {
      plan.desk.push({ ...base, ours: found.label, why: found.why });
      continue;
    }
    const { rubber, label } = found;
    const touched = officialsTouched(rubber);
    if (touched) {
      plan.skipped.push({ ...base, ours: label, why: touched });
      continue;
    }
    if (m.type === "doubles" && !found.fits(rubber)) {
      plan.desk.push({ ...base, ours: label, why: "doubles pair differs from our line-up (or not named yet)" });
      continue;
    }
    if (!rubber.teamA || !rubber.teamB) {
      plan.desk.push({ ...base, ours: label, why: "both sides must be known on Move Score" });
      continue;
    }
    const state = liveState(score, found.aIsP1, m.id);
    if (!state) {
      plan.desk.push({ ...base, ours: label, why: "Smash's live score could not be read" });
      continue;
    }
    plan.update.push({ court: m.court, smashId: m.id, matchId: rubber.id, tournamentId: rubber.tournamentId, ours: label, line: liveLine(state), state });
  }
  // Two Smash matches on one rubber: neither is written.
  const count = new Map<string, number>();
  for (const e of plan.update) count.set(e.matchId, (count.get(e.matchId) ?? 0) + 1);
  for (const e of plan.update.filter((x) => (count.get(x.matchId) ?? 0) > 1)) {
    plan.desk.push({ court: e.court, smashId: e.smashId, smash: e.ours, ours: e.ours, why: "two Smash matches in play map to this rubber: check by hand" });
  }
  plan.update = plan.update.filter((e) => (count.get(e.matchId) ?? 0) === 1);
  return plan;
}

/* ---------------- the switch ---------------- */

/** The importer stops by itself after the last day of the Cairo events: 8 Nov 2026, 21:00 Cairo (UTC+2). */
export const SMASH_IMPORT_END = "2026-11-08T21:00:00+02:00";

/** Whether a run may do anything: SMASH_IMPORT_ON=1, and not after the end (SMASH_IMPORT_UNTIL, an ISO time, overrides it). */
export function smashImportSwitch(env: { SMASH_IMPORT_ON?: string; SMASH_IMPORT_UNTIL?: string }, now: Date): { on: true; until: string } | { on: false; reason: string } {
  if (env.SMASH_IMPORT_ON !== "1") return { on: false, reason: "SMASH_IMPORT_ON is not 1" };
  const override = env.SMASH_IMPORT_UNTIL?.trim();
  const until = override && Number.isFinite(Date.parse(override)) ? override : SMASH_IMPORT_END;
  if (now.getTime() >= Date.parse(until)) return { on: false, reason: `ended at ${until}` };
  return { on: true, until };
}

/**
 * The live courts hero: what each court shows on the Move Score app's Discover on
 * a live day, swiped through court by court.
 *
 * The tennis court TV (src/lib/tennis/tvScene.ts) moves a wall through a tie on
 * its own; this is the same idea for every sport that takes part in the showcase
 * (src/lib/sports/registry.ts `supports.showcase`), for ties of rubbers and for
 * one-match fixtures (padel and every other games sport) alike, plus the moment
 * a match is called to its court:
 *
 *   next on court → called (players have N minutes) → walk-on of each side →
 *   live score → the result → (ties: the tie score between rubbers) → …
 *
 * Every decision is made from server-stamped times, so two phones looking at the
 * same court land on the same scene. The walk-on and result timings are the TV's.
 *
 * Pure: shared with the Move Score app through move-score-app/src/core/index.ts.
 */
import type { AppSkin, MCourtCall, MCourtPlayer, MCourtTeam, MCourtsEvent, MMatch, MMatchRules, MSides, MStageRules, MTie, SideKey } from "../mobile/contract";
import { nextOnCourt } from "../matchday/courtQueue";
import { isMatchDay, type MatchDayTournament } from "../matchday/eventDay";
import type { MatchDayRules } from "../matchday/rules";
import { stageRuleKey, type BracketTier } from "../scoring/rules";
import { sportOf } from "../sports/registry";
import { RUBBER_WON_MS, TIE_FINAL_MS, WALKON } from "../tennis/tvScene";
import type { Stage } from "../types";

export { RUBBER_WON_MS, TIE_FINAL_MS, WALKON };

/** A one-match fixture's result stays on its card, stilled, this long (as the venue screen's rest). */
export const RESULT_REST_MS = 5 * 60_000;

const LIVE = new Set(["live", "paused", "pending_sync"]);
const DONE = new Set(["completed", "walkover", "retired", "disqualified"]);
const WAITING = new Set(["scheduled", "ready"]);

export type ShowcaseScene =
  | { kind: "idle" }
  /** What goes on next: a tie's line-up, or the next one-match fixture. */
  | { kind: "next"; tieId: string | null; matchId: string | null }
  /** Called to court: the players have until `deadlineAt`. */
  | {
      kind: "called";
      tieId: string | null;
      matchId: string;
      calledAt: number;
      deadlineAt: number;
      msLeft: number;
      overdue: boolean;
      presentA: boolean;
      presentB: boolean;
    }
  /** Each side's walk-on card as the match starts; `elapsedMs` is into this side's card. */
  | { kind: "walkon"; tieId: string | null; matchId: string; side: SideKey; elapsedMs: number }
  | { kind: "live"; tieId: string | null; matchId: string }
  /** A finished match or rubber. `fresh` while it is the moment (the TV's rubber-won time), stilled after. */
  | { kind: "result"; tieId: string | null; matchId: string; elapsedMs: number; fresh: boolean }
  /** A tie between rubbers, or just finished (`final`). */
  | { kind: "tie_score"; tieId: string; final: boolean };

export type ShowcaseSceneKind = ShowcaseScene["kind"];

/** What follows on the same court, for the card's "Next on court" line. */
export interface ShowcaseNext {
  tieId: string | null;
  matchId: string | null;
}

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Time since an instant, never negative (a phone's clock a little behind the server's must not rewind a scene). */
function since(iso: string | null | undefined, now: number): number {
  const t = ms(iso);
  return t === null ? Number.POSITIVE_INFINITY : Math.max(0, now - t);
}

/** The court a match is on: its own, or its tie's (a rubber may carry none of its own). */
function courtOf(m: Pick<MMatch, "courtId" | "tieId">, tieCourt: Map<string, string | null>): string | null {
  return m.courtId ?? (m.tieId ? (tieCourt.get(m.tieId) ?? null) : null);
}

/** The next of these waiting matches, by the match-day queue (scheduled time, then match order). */
function queueNext(list: MMatch[]): MMatch | null {
  const rows = list.map((m) => ({ id: m.id, court_id: null, status: m.status, scheduled_time: m.scheduledTime, match_order: m.order, m }));
  return nextOnCourt(rows)?.m ?? null;
}

/** One court's view of the event, built once and asked several questions. */
class Court {
  readonly here: MMatch[];
  readonly ties: MTie[];
  private readonly byTie = new Map<string, MMatch[]>();
  private readonly tieCourt: Map<string, string | null>;

  constructor(
    readonly courtId: string,
    ties: MTie[],
    readonly matches: MMatch[],
  ) {
    this.tieCourt = new Map(ties.map((t) => [t.id, t.courtId]));
    this.here = matches.filter((m) => m.status !== "cancelled" && courtOf(m, this.tieCourt) === courtId);
    this.ties = ties.filter((t) => t.courtId === courtId).sort((a, b) => a.order - b.order);
    for (const m of matches) if (m.tieId) this.byTie.set(m.tieId, [...(this.byTie.get(m.tieId) ?? []), m]);
  }

  courtOf(m: MMatch): string | null {
    return courtOf(m, this.tieCourt);
  }

  rubbers(tieId: string): MMatch[] {
    return [...(this.byTie.get(tieId) ?? [])].sort((a, b) => (a.rubberNo ?? 0) - (b.rubberNo ?? 0));
  }

  started(tieId: string): boolean {
    return this.rubbers(tieId).some((r) => !WAITING.has(r.status) && r.status !== "cancelled");
  }

  finished(tieId: string): boolean {
    return this.rubbers(tieId).every((r) => DONE.has(r.status) || r.status === "cancelled");
  }

  lastEnd(tieId: string): number {
    return Math.max(0, ...this.rubbers(tieId).map((r) => ms(r.endedAt) ?? 0));
  }

  /** The next tie on this court that has not started and has both sides. */
  nextTie(except: string | null = null): MTie | null {
    return this.ties.find((t) => t.id !== except && t.status !== "completed" && !this.started(t.id) && t.a && t.b) ?? null;
  }

  /** The next one-match fixture waiting for this court. */
  nextMatch(except: string | null = null): MMatch | null {
    return queueNext(this.here.filter((m) => !m.tieId && WAITING.has(m.status) && m.id !== except));
  }
}

/**
 * The scene for one court at `now`. `ties`, `matches` and `calls` are the whole
 * event's; each is narrowed to this court here.
 *
 * Precedence: a match in play (its walk-on while fresh) → a result just in →
 * a match called to court → a tie between rubbers → a tie or result of the last
 * few minutes → what is next → idle.
 */
export function courtScene(courtId: string, ties: MTie[], matches: MMatch[], calls: MCourtCall[], now: number): ShowcaseScene {
  return sceneOf(new Court(courtId, ties, matches), calls, now);
}

function sceneOf(c: Court, calls: MCourtCall[], now: number): ShowcaseScene {
  // 1. In play: the most recently started.
  const live = c.here.filter((m) => LIVE.has(m.status)).sort((a, b) => (ms(b.startedAt) ?? 0) - (ms(a.startedAt) ?? 0))[0];
  if (live) {
    const t = since(live.startedAt, now);
    const fresh = (live.score?.lastEventNumber ?? 0) <= 1;
    if (live.status === "live" && fresh && t < WALKON.totalMs) {
      return { kind: "walkon", tieId: live.tieId, matchId: live.id, side: t < WALKON.perSideMs ? "A" : "B", elapsedMs: t % WALKON.perSideMs };
    }
    return { kind: "live", tieId: live.tieId, matchId: live.id };
  }

  // 2. Just finished.
  const latest = c.here.filter((m) => DONE.has(m.status) && m.endedAt).sort((a, b) => since(a.endedAt, now) - since(b.endedAt, now))[0];
  if (latest && since(latest.endedAt, now) < RUBBER_WON_MS) {
    return { kind: "result", tieId: latest.tieId, matchId: latest.id, elapsedMs: since(latest.endedAt, now), fresh: true };
  }

  // 3. Called to court and not started.
  const byId = new Map(c.matches.map((m) => [m.id, m]));
  const call = calls
    .filter((k) => {
      const m = byId.get(k.matchId);
      return Boolean(m && WAITING.has(m.status) && (c.courtOf(m) ?? k.courtId) === c.courtId);
    })
    .sort((a, b) => (ms(b.calledAt) ?? 0) - (ms(a.calledAt) ?? 0))[0];
  if (call) {
    const m = byId.get(call.matchId)!;
    const calledAt = ms(call.calledAt) ?? now;
    const deadlineAt = ms(call.deadlineAt) ?? calledAt;
    return {
      kind: "called",
      tieId: m.tieId,
      matchId: m.id,
      calledAt,
      deadlineAt,
      msLeft: Math.max(0, deadlineAt - now),
      overdue: now >= deadlineAt,
      presentA: call.presentA,
      presentB: call.presentB,
    };
  }

  // 4. A tie under way between rubbers.
  const between = c.ties.find((t) => c.started(t.id) && !c.finished(t.id));
  if (between) return { kind: "tie_score", tieId: between.id, final: false };

  // 5. A tie finished a little while ago, or a one-match result resting on the card.
  const recentTie = c.ties
    .filter((t) => c.started(t.id) && c.finished(t.id) && now - c.lastEnd(t.id) < TIE_FINAL_MS)
    .sort((a, b) => c.lastEnd(b.id) - c.lastEnd(a.id))[0];
  if (recentTie) return { kind: "tie_score", tieId: recentTie.id, final: true };
  if (latest && !latest.tieId && since(latest.endedAt, now) < RESULT_REST_MS) {
    return { kind: "result", tieId: null, matchId: latest.id, elapsedMs: since(latest.endedAt, now), fresh: false };
  }

  // 6. What is next on this court.
  const tie = c.nextTie();
  if (tie) return { kind: "next", tieId: tie.id, matchId: null };
  const next = c.nextMatch();
  if (next) return { kind: "next", tieId: null, matchId: next.id };
  return { kind: "idle" };
}

/** What follows the scene on the same court: the tie's next rubber, the next tie, or the next fixture. */
export function nextAfter(courtId: string, scene: ShowcaseScene, ties: MTie[], matches: MMatch[]): ShowcaseNext | null {
  return nextOf(new Court(courtId, ties, matches), scene);
}

function nextOf(c: Court, scene: ShowcaseScene): ShowcaseNext | null {
  if (scene.kind === "idle" || scene.kind === "next") return null;
  const tieId = scene.tieId;
  const current = "matchId" in scene ? scene.matchId : null;
  if (tieId) {
    const rubber = c.rubbers(tieId).find((r) => WAITING.has(r.status) && r.id !== current);
    if (rubber) return { tieId, matchId: rubber.id };
  }
  const tie = c.nextTie(tieId);
  if (tie) return { tieId: tie.id, matchId: null };
  const m = c.nextMatch(current);
  return m ? { tieId: null, matchId: m.id } : null;
}

/** Whether a scene is something happening now (the hero only shows on a day something is). */
export function isLiveScene(s: ShowcaseScene): boolean {
  return s.kind === "walkon" || s.kind === "live" || s.kind === "called" || s.kind === "result" || s.kind === "tie_score";
}

/** Every match a card is about: the scene's match, its tie's rubbers, and what is next. */
export function sceneMatchIds(scene: ShowcaseScene, next: ShowcaseNext | null, matches: MMatch[]): string[] {
  const ids = new Set<string>();
  const addTie = (tieId: string | null | undefined) => {
    if (tieId) for (const m of matches) if (m.tieId === tieId) ids.add(m.id);
  };
  if ("matchId" in scene && scene.matchId) ids.add(scene.matchId);
  if ("tieId" in scene) addTie(scene.tieId);
  if (next?.matchId) ids.add(next.matchId);
  else addTie(next?.tieId);
  return [...ids];
}

export interface HeroCard {
  /** `${tournamentId}:${courtId}`: stable across polls. */
  key: string;
  event: MCourtsEvent;
  /** The event's place in the Discover order. */
  eventIndex: number;
  court: { id: string; name: string; order: number };
  scene: ShowcaseScene;
  next: ShowcaseNext | null;
  live: boolean;
  /** The person plays in (or starred) a match on this card. */
  mine: boolean;
}

/**
 * Every court card of the hero at `now`, idle courts left out. Empty when nothing
 * is happening on any court, so the hero hides. Order: the person's own match
 * first, then the events in the Discover order, courts with something on before
 * courts waiting for their next match, then court order.
 */
export function heroCards(events: MCourtsEvent[], now: number, isMine?: (m: MMatch) => boolean): HeroCard[] {
  const cards: HeroCard[] = [];
  events.forEach((event, eventIndex) => {
    const byId = new Map(event.matches.map((m) => [m.id, m]));
    const courts = [...event.courts].sort((a, b) => a.order - b.order);
    for (const court of courts) {
      const c = new Court(court.id, event.ties, event.matches);
      const scene = sceneOf(c, event.calls, now);
      if (scene.kind === "idle") continue;
      const next = nextOf(c, scene);
      const mine = Boolean(isMine) && sceneMatchIds(scene, next, event.matches).some((id) => {
        const m = byId.get(id);
        return Boolean(m && isMine!(m));
      });
      cards.push({ key: `${event.tournament.id}:${court.id}`, event, eventIndex, court, scene, next, live: isLiveScene(scene), mine });
    }
  });
  if (!cards.some((c) => c.live)) return [];
  return cards.sort((a, b) => Number(b.mine) - Number(a.mine) || a.eventIndex - b.eventIndex || Number(b.live) - Number(a.live) || a.court.order - b.court.order);
}

/**
 * Whether a tournament's courts belong on the hero now: its sport takes part, the
 * organiser left the showcase on, it is running, and — when the showcase is for
 * event days only — today is one of its match days (a tournament without dates
 * counts only while a match is live).
 */
export function showcaseOn(
  t: MatchDayTournament & { sport?: string | null },
  rules: Pick<MatchDayRules, "showcase">,
  liveCount: number,
  now: number,
): boolean {
  if (!sportOf(t.sport).supports.showcase) return false;
  if (!rules.showcase.on || t.status !== "active") return false;
  return rules.showcase.eventDaysOnly ? isMatchDay(t, now, liveCount > 0) : true;
}

/** How many waiting one-match fixtures per court the server sends: the next, and the one after it. */
const QUEUE_DEPTH = 2;

/**
 * The matches and ties the server sends for an event's courts: enough for every
 * scene and "next" line of the next few minutes, not the whole day's fixtures.
 * Per court: what is in play, what finished in the last few minutes, open calls,
 * the ties in progress, just finished and next (with all their rubbers), and the
 * next two fixtures in the queue.
 */
export function showcaseSubset(courtIds: string[], ties: MTie[], matches: MMatch[], calls: MCourtCall[], now: number): { matchIds: Set<string>; tieIds: Set<string> } {
  const matchIds = new Set<string>();
  const tieIds = new Set<string>();
  const keep = Math.max(RESULT_REST_MS, TIE_FINAL_MS) + 60_000;
  const called = new Set(calls.map((k) => k.matchId));
  for (const courtId of courtIds) {
    const c = new Court(courtId, ties, matches);
    for (const m of c.here) {
      if (LIVE.has(m.status) || (DONE.has(m.status) && since(m.endedAt, now) < keep) || (WAITING.has(m.status) && called.has(m.id))) matchIds.add(m.id);
    }
    const waiting = c.here.filter((m) => !m.tieId && WAITING.has(m.status));
    for (let i = 0, list = waiting; i < QUEUE_DEPTH; i++) {
      const next = queueNext(list);
      if (!next) break;
      matchIds.add(next.id);
      list = list.filter((m) => m.id !== next.id);
    }
    const keepTie = (t: MTie) => {
      tieIds.add(t.id);
      for (const r of c.rubbers(t.id)) matchIds.add(r.id);
    };
    for (const t of c.ties) {
      const started = c.started(t.id);
      const finished = c.finished(t.id);
      if ((started && !finished) || (started && finished && now - c.lastEnd(t.id) < TIE_FINAL_MS + 60_000)) keepTie(t);
    }
    const first = c.nextTie();
    if (first) {
      keepTie(first);
      const second = c.nextTie(first.id);
      if (second) keepTie(second);
    }
  }
  // A rubber kept for its own sake brings its tie (for the tie score and line-up).
  for (const m of matches) if (m.tieId && matchIds.has(m.id)) tieIds.add(m.tieId);
  return { matchIds, tieIds };
}

/** The rules one match is played under, from the bundle's per-stage rules. */
export function rulesForMatch(rules: MStageRules, m: Pick<MMatch, "stage" | "bracketId" | "rubberType" | "aPlayers" | "bPlayers">): MMatchRules {
  const tier: BracketTier | null = m.bracketId ? (rules.plateBrackets.includes(m.bracketId) ? "plate" : "cup") : null;
  // An unknown stage (a newer server) has no bucket: the base rules.
  const key = stageRuleKey(m.stage as Stage, tier) ?? null;
  const staged = (key && rules.stages[key]) || rules.base;
  const doubles = m.rubberType ? m.rubberType === "D" : m.aPlayers.length > 1 || m.bPlayers.length > 1;
  return doubles && rules.doubles ? { ...staged, ...rules.doubles } : staged;
}

/* ---------- who is on each side ---------- */

/** How a side is told apart on a card: its flag, its logo, or a colour (with a word when it is red or blue). */
export type SideIdentity =
  | { kind: "flag"; iso2: string; code: string; label: string }
  | { kind: "logo"; url: string; code: string; label: string }
  | { kind: "colour"; hex: string; code: string; label: string; word: string | null };

/** The colours the Discover cards fall back to when an event has no skin. */
const FALLBACK_HEX: Record<SideKey, string> = { A: "#d8572a", B: "#8a4fff" };
const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * A side's identity. Red and blue teams (when the organiser turned them on) win,
 * because the umpire calls the sides by colour; then a nation's flag; then a
 * logo; else the event's own colour for that side.
 */
export function sideIdentity(
  team: { name: string; code: string; iso2?: string | null; logoUrl?: string | null } | null | undefined,
  side: SideKey,
  sides?: MSides | null,
  skin?: Pick<AppSkin, "seedA" | "seedB"> | null,
): SideIdentity {
  const code = team?.code ?? "TBD";
  const label = team?.name ?? "To be decided";
  if (sides?.redBlue) return { kind: "colour", hex: sides[side].hex, code, label, word: sides[side].short };
  if (team?.iso2 && /^[a-z]{2}$/.test(team.iso2)) return { kind: "flag", iso2: team.iso2, code, label };
  if (team?.logoUrl) return { kind: "logo", url: team.logoUrl, code, label };
  const seed = side === "A" ? skin?.seedA : skin?.seedB;
  return { kind: "colour", hex: seed && HEX.test(seed) ? seed : FALLBACK_HEX[side], code, label, word: null };
}

/** The players on one side: the nominated ones, else (outside ties) the whole team. */
export function sidePlayers(event: Pick<MCourtsEvent, "teams">, m: MMatch, side: SideKey): MCourtPlayer[] {
  const teamId = side === "A" ? m.a : m.b;
  const team = event.teams.find((t) => t.id === teamId);
  const ids = side === "A" ? m.aPlayers : m.bPlayers;
  if (ids.length) {
    const all = new Map(event.teams.flatMap((t) => t.players.map((p) => [p.id, p] as const)));
    return ids.map((id) => all.get(id)).filter((p): p is MCourtPlayer => Boolean(p));
  }
  return m.tieId ? [] : (team?.players ?? []);
}

/** "Hassan / Sato" for nominated players, else the team's name (or code when `short`). */
export function sideName(event: Pick<MCourtsEvent, "teams">, m: MMatch, side: SideKey, short = false): string {
  const team: MCourtTeam | undefined = event.teams.find((t) => t.id === (side === "A" ? m.a : m.b));
  if (!team) return "TBD";
  const ps = m.tieId ? sidePlayers(event, m, side) : [];
  if (!ps.length) return short ? team.code : team.name;
  const surname = (n: string) => n.trim().split(/\s+/).slice(-1)[0] ?? n;
  return ps.map((p) => (short ? surname(p.name) : p.name)).join(" / ");
}

/**
 * The broadcast overlay's view model: what the score bug in the corner of the
 * live video shows for one court, at one moment. Pure and framework-free.
 *
 * Built from the same live feed the court TVs poll (src/lib/tv/liveFeed.ts) and
 * the public facts the page was rendered with (nations or teams, nominees,
 * rules, ties). It decides the state — a match in play, a result just finished,
 * the next match on the court, nothing — and every line of text, so the
 * component only draws.
 */
import { currentServer, servingPlayer, type ScoreState, type TeamKey } from "../scoring/engine";
import { aceMoment } from "../scoring/serve";
import { TIMERS, liveClock } from "../scoring/timing";
import { callout, tieScore, type SceneRubber } from "../tennis/tvScene";
import type { LiveMatch, LiveSnapshot } from "../tv/liveFeed";
import type { CompletedSet, MatchRules } from "../types";

/** A result stays in the corner this long before the bug moves on to what is next. */
export const FINAL_HOLD_MS = 120_000;

const IN_PLAY = ["live", "paused"];
const DONE = ["completed", "walkover", "retired", "disqualified"];
const WAITING = ["scheduled", "ready"];

/** A side as the overlay may know it: public fields only. */
export interface OverlayTeam {
  id: string;
  /** Three letters: the nation code, or a short code for a team. */
  code: string;
  iso2: string | null;
  name: string;
  players: { id: string; name: string }[];
}

export interface OverlayTie {
  id: string;
  court_id: string | null;
  tie_order: number;
  team_a_id: string | null;
  team_b_id: string | null;
  round_name: string | null;
}

/** What the lean feed does not carry about a match. */
export interface OverlayMatchInfo {
  id: string;
  tie_id: string | null;
  rubber_no: number | null;
  rubber_type: string | null;
  /** Nominated players (rubbers); empty for a team that plays as itself. */
  a: string[];
  b: string[];
  round_name: string | null;
  rules: Pick<MatchRules, "setsToWinMatch" | "gamesToWinSet" | "tiebreakEnabled" | "tiebreakAtGames" | "tiebreakTargetPoints" | "tiebreakWinByTwo" | "decidingPoint" | "matchTiebreak" | "matchTiebreakPoints" | "walkoverScore">;
}

export interface OverlaySwitches {
  /** The organiser's "Show aces on TV & app" (and Ace on). */
  aces: boolean;
  /** The organiser's "Show timers on TV & app". */
  timers: boolean;
}

export interface OverlayInput {
  courtId: string;
  courtName: string;
  /** The header strip's first words: the overlay title, else the tournament's name. */
  title: string;
  matches: LiveMatch[];
  snapshots: LiveSnapshot[];
  info: Record<string, OverlayMatchInfo>;
  teams: Record<string, OverlayTeam>;
  ties: OverlayTie[];
  now: number;
  switches: OverlaySwitches | null;
  timeZone: string;
}

export interface OverlaySet {
  games: number;
  /** The loser's tie-break points, shown small beside a set lost in a tie-break. */
  tb: number | null;
  won: boolean;
}

export interface OverlayRow {
  teamId: string | null;
  code: string;
  iso2: string | null;
  /** One line per player of a pair, or the team's own name. */
  names: string[];
  serving: boolean;
  /** Doubles: which of the two names is serving. */
  servingIndex: number | null;
  sets: OverlaySet[];
  /** Games in the set being played; null in a match tie-break and once over. */
  games: number | null;
  /** Points (or tie-break points) of the game in play; null once over. */
  points: string | null;
  winner: boolean;
}

export interface OverlayClock {
  label: string;
  text: string;
  over: boolean;
}

export type OverlayModel =
  | {
      kind: "live" | "final";
      matchId: string;
      header: string[];
      label: "Points" | "Tie-break" | "Super TB" | "Final";
      rows: [OverlayRow, OverlayRow];
      /** Match point, set point, break point… (not with a running timer). */
      callout: string | null;
      /** The ACE moment: the last point was an ace (until the next point). */
      ace: boolean;
      clock: OverlayClock | null;
      paused: boolean;
      eventNumber: number;
    }
  | { kind: "next"; matchId: string; header: string[]; rows: [OverlayRow, OverlayRow] }
  | { kind: "idle"; header: string[] };

/** "Giulia Safina Popa" → "G. Popa"; a single word stays as it is. */
export function shortName(full: string): string {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] ?? "";
  return `${parts[0][0]}. ${parts[parts.length - 1]}`;
}

function clockIn(iso: string | null, timeZone: string): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone }).format(at);
  } catch {
    return null;
  }
}

function sideTeam(input: OverlayInput, m: LiveMatch, side: TeamKey): string | null {
  const own = side === "A" ? m.team_a_id : m.team_b_id;
  if (own) return own;
  // A rubber not yet given its nations takes them from its tie.
  const tieId = input.info[m.id]?.tie_id;
  const tie = tieId ? input.ties.find((t) => t.id === tieId) : undefined;
  return (side === "A" ? tie?.team_a_id : tie?.team_b_id) ?? null;
}

function namesOf(input: OverlayInput, m: LiveMatch, side: TeamKey): { team: OverlayTeam | undefined; names: string[] } {
  const teamId = sideTeam(input, m, side);
  const team = teamId ? input.teams[teamId] : undefined;
  const info = input.info[m.id];
  const ids = info ? (side === "A" ? info.a : info.b) : [];
  const players = ids.map((id) => team?.players.find((p) => p.id === id)).filter((p): p is { id: string; name: string } => Boolean(p));
  if (players.length) return { team, names: players.map((p) => shortName(p.name)) };
  // A tie's rubber with no nominees yet: the nation. A team plays as its own name.
  return { team, names: [team?.name ?? "To be decided"] };
}

function setsOf(sets: CompletedSet[], k: 0 | 1): OverlaySet[] {
  return sets.map((x) => {
    const mine = k === 0 ? x.teamAGames : x.teamBGames;
    const theirs = k === 0 ? x.teamBGames : x.teamAGames;
    if (x.matchTiebreak && x.tiebreak) {
      const p = k === 0 ? x.tiebreak.a : x.tiebreak.b;
      const q = k === 0 ? x.tiebreak.b : x.tiebreak.a;
      return { games: p, tb: null, won: p > q };
    }
    const tb = x.tiebreak && mine < theirs ? (k === 0 ? x.tiebreak.a : x.tiebreak.b) : null;
    return { games: mine, tb, won: mine > theirs };
  });
}

function sceneRubbers(input: OverlayInput): SceneRubber[] {
  const snaps = new Map(input.snapshots.map((s) => [s.match_id, s]));
  return input.matches.flatMap((m) => {
    const info = input.info[m.id];
    if (!info?.tie_id) return [];
    return [{
      id: m.id,
      tie_id: info.tie_id,
      rubber_no: info.rubber_no ?? 1,
      rubber_type: (info.rubber_type ?? "S1") as SceneRubber["rubber_type"],
      court_id: m.court_id,
      status: m.status,
      started_at: m.started_at,
      ended_at: m.ended_at,
      winner_team_id: m.winner_team_id,
      team_a_id: m.team_a_id,
      team_b_id: m.team_b_id,
      last_event_number: snaps.get(m.id)?.last_event_number ?? 0,
    }];
  });
}

/** "EGY 1–0 USA" for a tie, from its rubbers as they stand in the feed. */
function tieLine(input: OverlayInput, tieId: string): string | null {
  const tie = input.ties.find((t) => t.id === tieId);
  if (!tie) return null;
  const [a, b] = tieScore(sceneRubbers(input).filter((r) => r.tie_id === tieId), tie.team_a_id);
  const ca = tie.team_a_id ? input.teams[tie.team_a_id]?.code : null;
  const cb = tie.team_b_id ? input.teams[tie.team_b_id]?.code : null;
  return `${ca ?? "TBD"} ${a}–${b} ${cb ?? "TBD"}`;
}

function headerFor(input: OverlayInput, m: LiveMatch, extra: string | null): string[] {
  const info = input.info[m.id];
  const parts = [input.title];
  if (info?.tie_id) {
    const line = tieLine(input, info.tie_id);
    if (line) parts.push(line);
    if (info.rubber_type) parts.push(info.rubber_type);
  } else if (info?.round_name ?? m.round_name) {
    parts.push((info?.round_name ?? m.round_name)!);
  }
  if (extra) parts.push(extra);
  return parts.filter(Boolean);
}

/** The match this court's bug is about, and in which state. */
export function overlayMatch(input: OverlayInput): { match: LiveMatch; kind: "live" | "final" | "next" } | null {
  const courtTies = new Set(input.ties.filter((t) => t.court_id === input.courtId).map((t) => t.id));
  const onCourt = (m: LiveMatch) => {
    if (m.court_id) return m.court_id === input.courtId;
    const tieId = input.info[m.id]?.tie_id;
    return Boolean(tieId && courtTies.has(tieId));
  };
  const here = input.matches.filter(onCourt);
  const ms = (iso: string | null | undefined) => {
    const n = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(n) ? n : 0;
  };
  const snapAt = new Map(input.snapshots.map((s) => [s.match_id, ms(s.updated_at)]));
  /** When the match last moved: its latest score, else its start. */
  const activity = (m: LiveMatch) => Math.max(snapAt.get(m.id) ?? 0, ms(m.started_at));
  /** The latest end of another match on this court. */
  const lastEnd = Math.max(0, ...here.filter((m) => DONE.includes(m.status)).map((m) => ms(m.ended_at)));

  // The court's match in play is the one being scored now. A match left "live"
  // (started, then abandoned for another) never beats one whose score moved more
  // recently, and once another match has finished on this court since it last
  // moved it is not what the camera shows.
  const inPlay = here.filter((m) => IN_PLAY.includes(m.status));
  const live = inPlay
    .filter((m) => activity(m) >= lastEnd)
    .sort((a, b) => activity(b) - activity(a) || ms(b.started_at) - ms(a.started_at))[0];
  if (live) return { match: live, kind: "live" };

  const done = here
    .filter((m) => DONE.includes(m.status) && m.ended_at && input.now - ms(m.ended_at) >= 0 && input.now - ms(m.ended_at) < FINAL_HOLD_MS)
    .sort((a, b) => ms(b.ended_at) - ms(a.ended_at))[0];
  if (done) return { match: done, kind: "final" };

  const tieOrder = (m: LiveMatch) => {
    const tieId = input.info[m.id]?.tie_id;
    return tieId ? (input.ties.find((t) => t.id === tieId)?.tie_order ?? 0) : 0;
  };
  const next = here
    .filter((m) => WAITING.includes(m.status) && sideTeam(input, m, "A") && sideTeam(input, m, "B"))
    .sort(
      (a, b) =>
        tieOrder(a) - tieOrder(b) ||
        (input.info[a.id]?.rubber_no ?? 0) - (input.info[b.id]?.rubber_no ?? 0) ||
        (a.scheduled_time ?? "￿").localeCompare(b.scheduled_time ?? "￿") ||
        a.match_order - b.match_order,
    )[0];
  return next ? { match: next, kind: "next" } : null;
}

export function overlayModel(input: OverlayInput): OverlayModel {
  const pick = overlayMatch(input);
  if (!pick) return { kind: "idle", header: [input.title, input.courtName].filter(Boolean) };
  const m = pick.match;
  const snap = input.snapshots.find((s) => s.match_id === m.id);
  const info = input.info[m.id];

  if (pick.kind === "next") {
    const when = clockIn(m.scheduled_time, input.timeZone);
    const row = (side: TeamKey): OverlayRow => {
      const { team, names } = namesOf(input, m, side);
      return { teamId: team?.id ?? null, code: team?.code ?? "TBD", iso2: team?.iso2 ?? null, names, serving: false, servingIndex: null, sets: [], games: null, points: null, winner: false };
    };
    return { kind: "next", matchId: m.id, header: headerFor(input, m, when ? `Next · ${when}` : "Next"), rows: [row("A"), row("B")] };
  }

  const state: ScoreState | undefined = pick.kind === "live" ? snap?.state : undefined;
  const over = pick.kind === "final" || Boolean(snap?.match_over);
  const serverTeam: TeamKey | null = over
    ? null
    : state
      ? currentServer(state)
      : snap?.serving_team_id
        ? snap.serving_team_id === m.team_a_id ? "A" : "B"
        : null;
  const doubles = state ? servingPlayer(state) : null;
  const completed = snap?.completed_sets ?? [];
  const tiebreak = Boolean(snap?.tiebreak);
  const matchTb = Boolean(snap?.match_tiebreak);

  const row = (side: TeamKey): OverlayRow => {
    const k = side === "A" ? 0 : 1;
    const { team, names } = namesOf(input, m, side);
    const teamId = team?.id ?? (side === "A" ? m.team_a_id : m.team_b_id);
    return {
      teamId,
      code: team?.code ?? "TBD",
      iso2: team?.iso2 ?? null,
      names,
      serving: serverTeam === side,
      servingIndex: serverTeam === side && names.length > 1 && doubles ? doubles.index : null,
      sets: setsOf(completed, k),
      games: over || !snap || matchTb ? null : snap.games[k],
      points: over || !snap ? (over ? null : "0") : tiebreak ? String(snap.tiebreak_points[k]) : snap.points[k],
      winner: Boolean(over && m.winner_team_id && m.winner_team_id === teamId),
    };
  };

  const on = input.switches;
  const live = pick.kind === "live" && !over;
  const timer = live && on?.timers && state ? liveClock(state, input.now) : null;
  const clock: OverlayClock | null = timer
    ? { label: timer.kind === "changeover" ? "Changeover" : TIMERS[timer.kind].label, text: timer.text, over: timer.over }
    : null;
  const ace = Boolean(live && on?.aces && aceMoment(state));
  const call = live && !clock && info ? callout(state, info.rules as MatchRules) : null;

  return {
    kind: pick.kind,
    matchId: m.id,
    header: headerFor(input, m, pick.kind === "final" ? "Final" : null),
    label: over ? "Final" : matchTb ? "Super TB" : tiebreak ? "Tie-break" : "Points",
    rows: [row("A"), row("B")],
    callout: call,
    ace,
    clock,
    paused: m.status === "paused",
    eventNumber: snap?.last_event_number ?? 0,
  };
}

/** Query switches of the overlay URL: `?bug=0` hides the score bug, `?footer=0` the sponsors, `?scale=1.25` sizes both. */
export interface OverlayOptions {
  bug: boolean;
  footer: boolean;
  scale: number;
  /** `?idle=0`: no strip at all when nothing is on or next on the court. */
  idle: boolean;
}

const off = (v: string | string[] | undefined) => {
  const s = Array.isArray(v) ? v[0] : v;
  return s === "0" || s === "false" || s === "off" || s === "no";
};

export function overlayOptions(q: Record<string, string | string[] | undefined>): OverlayOptions {
  const raw = Array.isArray(q.scale) ? q.scale[0] : q.scale;
  const n = raw ? Number(raw) : 1;
  return {
    bug: !off(q.bug),
    footer: !off(q.footer),
    idle: !off(q.idle),
    scale: Number.isFinite(n) ? Math.min(2, Math.max(0.5, n)) : 1,
  };
}

const slugOf = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * The court an overlay URL names: its id (what the admin page copies, which
 * survives a rename), or its name, typed or slugged ("Court 13", "court-13").
 * Names are not unique, so the lowest court order wins.
 */
export function resolveCourtParam<C extends { id: string; court_name: string; court_order: number }>(courts: C[], param: string): C | undefined {
  const wanted = decodeURIComponent(param).trim();
  const byId = courts.find((c) => c.id === wanted);
  if (byId) return byId;
  const lower = wanted.toLowerCase();
  const slug = slugOf(wanted);
  return [...courts]
    .sort((a, b) => a.court_order - b.court_order)
    .find((c) => c.court_name.trim().toLowerCase() === lower || slugOf(c.court_name) === slug);
}

/** The global the overlay stamps (Date.now()) every time it draws a frame on the client. */
export const OVERLAY_ALIVE_KEY = "__mbOverlayAlive";
/** How long without a client frame before the watchdog reloads the page. */
export const OVERLAY_WATCHDOG_MS = 30_000;

/**
 * An inline, ES5-only script for the overlay page. If the client never comes
 * alive (a browser source too old for the bundle, a script blocked or crashed)
 * or stops drawing, the page would show its server frame forever: a score that
 * never moves. The watchdog reloads it instead, so even then the bug catches up
 * every half minute.
 */
export const OVERLAY_WATCHDOG = `(function(){var w=window,k="${OVERLAY_ALIVE_KEY}",s=Date.now();setInterval(function(){if(document.hidden){w[k]=Date.now();return;}if(Date.now()-(w[k]||s)>${OVERLAY_WATCHDOG_MS})location.reload();},5000);})();`;

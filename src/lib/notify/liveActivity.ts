/**
 * iPhone Live Activities: what the lock-screen card shows and the APNs payloads
 * that start, update and end it. The transport (HTTP/2 to Apple, token tables)
 * is apns.ts; everything here is pure, so the server and the app agree on the
 * card's props and the payloads are unit-tested.
 *
 * A match's card goes through four phases:
 *
 *   soon     the match is next on its court; `until` = when it should start
 *   called   called to court; `until` = the deadline to be there (extensions included)
 *   live     the score, point by point
 *   final    the result; the card is ended and dismissed a while later
 *
 * `until` (epoch ms) drives the card's countdown (`Text timerInterval` in
 * move-score-app/src/live/MatchScoreActivity.tsx); null shows no countdown, as
 * when the tournament switched "countdown" off.
 *
 * Pure: shared with the Move Score app through move-score-app/src/core/index.ts.
 */
import type { MScore } from "../mobile/contract";
import type { CallView } from "../matchday/call";

/** Must match createLiveActivity("MatchScore", …) in the app. */
export const LIVE_ACTIVITY_NAME = "MatchScore";
/**
 * The ActivityAttributes struct expo-widgets compiles into the widget extension
 * (node_modules/expo-widgets/ios/Widgets/WidgetLiveActivity.swift). Push-to-start
 * names it in `attributes-type`; its only field is the deep link `url`.
 */
export const LIVE_ACTIVITY_ATTRIBUTES_TYPE = "LiveActivityAttributes";

export type LiveActivityPhase = "soon" | "called" | "live" | "final";
export const LIVE_ACTIVITY_PHASES: readonly LiveActivityPhase[] = ["soon", "called", "live", "final"];

/** The card's props, as the app's layout reads them. Older apps read only a…court and ignore the rest. */
export interface LiveScoreState {
  a: string;
  b: string;
  sets: string;
  points: string;
  serving: "A" | "B" | null;
  status: string;
  court: string;
  /** Absent from servers before Phase 6: the app then reads the card as live. */
  matchId?: string;
  phase?: LiveActivityPhase;
  /** Countdown target (epoch ms), soon and called only. */
  until?: number | null;
  /** Countdown start (epoch ms): the call time, so the timer's range is stable across renders. */
  from?: number | null;
}

/** How long a live score stays fresh without a push before iOS dims it. */
export const LIVE_STALE_SECONDS = 120;
/** A countdown card stays fresh this long after its deadline (the referee is deciding). */
export const COUNTDOWN_GRACE_SECONDS = 10 * 60;
/** A finished match's card stays on the lock screen this long. */
export const FINAL_DISMISS_SECONDS = 15 * 60;

export function matchUrl(matchId: string): string {
  return `movescore://match/${matchId}`;
}

/** The match id in a card's deep link, or null. */
export function matchIdFromUrl(url: string | null | undefined): string | null {
  const m = /^movescore:\/\/match\/([A-Za-z0-9-]{1,64})(?:[/?#]|$)/.exec(url ?? "");
  return m ? m[1]! : null;
}

function scoreLines(score: MScore | null): { sets: string; points: string } {
  return {
    sets: [...(score?.sets ?? []).map((s) => `${s.a}-${s.b}`), ...(score?.games ? [`${score.games.a}-${score.games.b}`] : [])].join(" "),
    points: score?.points ? `${score.points.a}-${score.points.b}` : "",
  };
}

/**
 * The live (or final) card. `labels.status` is what the card says ("Live",
 * "Paused", "Final"); `phase` defaults from it.
 */
export function liveState(
  score: MScore | null,
  labels: { a: string; b: string; court: string; status: string },
  extra: { matchId?: string; phase?: LiveActivityPhase } = {},
): LiveScoreState {
  const phase = extra.phase ?? (labels.status === "Final" ? "final" : "live");
  return {
    a: labels.a,
    b: labels.b,
    ...scoreLines(score),
    serving: phase === "live" ? (score?.serving ?? null) : null,
    status: labels.status,
    court: labels.court,
    ...(extra.matchId ? { matchId: extra.matchId } : {}),
    phase,
    until: null,
    from: null,
  };
}

/** The card before the first point: next on court (soon) or called to court. */
export function upcomingState(opts: {
  matchId: string;
  phase: "soon" | "called";
  a: string;
  b: string;
  court: string;
  /** Epoch ms; null or `countdown: false` shows no timer. */
  until: number | null;
  from?: number | null;
  countdown?: boolean;
}): LiveScoreState {
  const timer = opts.countdown !== false && Number.isFinite(opts.until ?? NaN);
  return {
    a: opts.a,
    b: opts.b,
    sets: "",
    points: "",
    serving: null,
    status: opts.phase === "called" ? "Called to court" : "Up next",
    court: opts.court,
    matchId: opts.matchId,
    phase: opts.phase,
    until: timer ? opts.until! : null,
    from: timer && Number.isFinite(opts.from ?? NaN) ? opts.from! : null,
  };
}

/**
 * Which phase a match is in, from its status, its court call (callView) and its
 * scheduled time. Null when there is nothing to show (cancelled, no call and not
 * yet due). A call that is open (called, reminder, overdue, no-show, all present)
 * is "called" with the deadline as `until`.
 */
export function phaseForMatch(m: {
  status: string;
  scheduledTime?: string | number | null;
  call?: Pick<CallView, "phase" | "deadlineAt" | "calledAt"> | null;
  /** "soon" without a call: when the match is next on its court (court queue / near-end). */
  nextOnCourt?: boolean;
}): { phase: LiveActivityPhase; until: number | null; from: number | null } | null {
  if (m.status === "completed" || m.status === "walkover" || m.status === "retired") return { phase: "final", until: null, from: null };
  if (m.status === "live" || m.status === "paused") return { phase: "live", until: null, from: null };
  if (m.status === "cancelled") return null;
  if (m.call && m.call.phase !== "closed") return { phase: "called", until: m.call.deadlineAt, from: m.call.calledAt };
  if (m.nextOnCourt) {
    const t = typeof m.scheduledTime === "number" ? m.scheduledTime : m.scheduledTime ? Date.parse(m.scheduledTime) : NaN;
    return { phase: "soon", until: Number.isFinite(t) ? t : null, from: null };
  }
  return null;
}

/** When iOS should dim the card if no push arrives (epoch seconds), or undefined for none. */
export function staleDateFor(state: LiveScoreState, nowSec: number): number | undefined {
  const phase = state.phase ?? "live";
  if (phase === "final") return undefined;
  if ((phase === "soon" || phase === "called") && state.until) {
    return Math.max(nowSec + LIVE_STALE_SECONDS, Math.ceil(state.until / 1000) + COUNTDOWN_GRACE_SECONDS);
  }
  return nowSec + LIVE_STALE_SECONDS;
}

/** expo-widgets' ContentState: the activity's name and its props as a JSON string. */
export function contentState(state: LiveScoreState) {
  return { name: LIVE_ACTIVITY_NAME, props: JSON.stringify(state) };
}

export interface ApsAlert {
  title: string;
  body: string;
}

/** An update (or end) push to one activity's update token. */
export function updatePayload(state: LiveScoreState, opts: { nowSec: number; end?: boolean; alert?: ApsAlert | null }) {
  const stale = opts.end ? undefined : staleDateFor(state, opts.nowSec);
  return {
    aps: {
      timestamp: opts.nowSec,
      event: opts.end ? "end" : "update",
      "content-state": contentState(state),
      ...(stale !== undefined ? { "stale-date": stale } : {}),
      ...(opts.end ? { "dismissal-date": opts.nowSec + FINAL_DISMISS_SECONDS } : {}),
      ...(opts.alert ? { alert: opts.alert, sound: "default" } : {}),
    },
  };
}

/**
 * A push-to-start payload (iOS 17.2+), sent to the phone's push-to-start token.
 * Apple requires an alert on a start. `input-push-token: 1` asks iOS 18+ to hand
 * the app an update token for the new activity (the app registers it through the
 * activityUpdates observer added by patches/expo-widgets+*.patch); iOS 17.2–17.x
 * ignores it and the app registers the token the next time it runs.
 */
export function startPayload(state: LiveScoreState, opts: { nowSec: number; alert: ApsAlert }) {
  if (!state.matchId) throw new Error("startPayload needs state.matchId");
  const stale = staleDateFor(state, opts.nowSec);
  return {
    aps: {
      timestamp: opts.nowSec,
      event: "start",
      "attributes-type": LIVE_ACTIVITY_ATTRIBUTES_TYPE,
      attributes: { url: matchUrl(state.matchId) },
      "content-state": contentState(state),
      ...(stale !== undefined ? { "stale-date": stale } : {}),
      "input-push-token": 1,
      alert: opts.alert,
      sound: "default",
    },
  };
}

/** The alert that comes with a push-started card. */
export function startAlert(state: LiveScoreState): ApsAlert {
  const vs = `${state.a || "TBD"} v ${state.b || "TBD"}`;
  const where = state.court ? ` on ${state.court}` : "";
  switch (state.phase) {
    case "called":
      return { title: "Called to court", body: `${vs}${where}. Head to the court now.` };
    case "soon":
      return { title: "Your match is up next", body: `${vs}${where}.` };
    case "final":
      return { title: "Final", body: `${vs} ${state.sets}`.trim() };
    default:
      return { title: "Match live", body: `${vs}${where}.` };
  }
}

/** Which phases may start a card by push, under the tournament's lock-screen rules. */
export function startByPushAllowed(lockScreen: { liveActivities: boolean; startByPush: boolean }, phase: LiveActivityPhase): boolean {
  // A finished match never starts a card.
  return lockScreen.liveActivities && lockScreen.startByPush && phase !== "final";
}

/* ---------------- tokens ---------------- */

export interface ApnsResult {
  status: number;
  reason: string | null;
}

/** Reasons that mean this token will never work again. */
const DEAD_REASONS = new Set(["BadDeviceToken", "Unregistered", "ExpiredToken"]);

/** What to do with a token after Apple's answer. */
export function apnsVerdict(r: ApnsResult): "ok" | "dead" | "config" | "retry" {
  if (r.status === 200) return "ok";
  if (r.status === 410 || (r.reason && DEAD_REASONS.has(r.reason))) return "dead";
  if (r.status === 403 || r.reason === "BadTopic" || r.reason === "TopicDisallowed" || r.reason === "MissingTopic") return "config";
  return "retry";
}

/** APNs device, activity and push-to-start tokens: hex. Activity tokens are longer than device tokens and Apple may lengthen them again. */
export const APNS_TOKEN = /^[0-9a-f]{40,400}$/i;

/**
 * The start-token route's body: exactly `{ token }`, a hex APNs token. Unknown
 * fields are refused so a typo or an older shape never half-saves.
 */
export function parseStartTokenBody(body: unknown): { ok: true; token: string } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "Send { token }" };
  const keys = Object.keys(body);
  const extra = keys.filter((k) => k !== "token");
  if (extra.length) return { ok: false, error: `Unknown field: ${extra[0]!.slice(0, 40)}` };
  const token = (body as { token?: unknown }).token;
  if (typeof token !== "string" || !APNS_TOKEN.test(token)) return { ok: false, error: "token must be a hex APNs token" };
  return { ok: true, token: token.toLowerCase() };
}

/**
 * The operator's live controls, as data.
 *
 * One command vocabulary for a single screen's console and for pushing to many
 * screens at once, resolved per screen into the columns it writes. Pure: the
 * caller supplies the time and the facts about the tournament, so every stamp is
 * the server's clock and every rule is testable without a database.
 *
 * Every timeline the wall plays because of a command — a break's countdown, a
 * ceremony step, a replayed entrance — is written as a server timestamp that the
 * screen seeks from. A reload, a second wall or a slow poll lands on the same
 * frame instead of starting the animation again.
 */
import { normalizeDisplayMode, type ScreenSettings } from "../types";
import type { ScreenPatch } from "../screens";
import { planGrid, showsAt } from "./layout";

export type CeremonyMove = "next" | "back" | "replay" | "restart";

export type ScreenCommand =
  | { kind: "mute"; on: boolean }
  | { kind: "break_start"; minutes: number }
  | { kind: "break_end" }
  | { kind: "replay_entrance"; matchId: string }
  | { kind: "ceremony"; move: CeremonyMove };

/** Longest break the console offers: a lunch break, not a day. */
export const MAX_BREAK_MINUTES = 120;

/** Reads a command from a form. Null when the form does not carry a valid one. */
export function parseScreenCommand(get: (name: string) => string | null): ScreenCommand | null {
  switch (get("command")) {
    case "mute_on":
      return { kind: "mute", on: true };
    case "mute_off":
      return { kind: "mute", on: false };
    case "break_start": {
      const minutes = Number(get("break_minutes"));
      if (!Number.isFinite(minutes) || minutes <= 0) return null;
      return { kind: "break_start", minutes: Math.min(MAX_BREAK_MINUTES, Math.round(minutes)) };
    }
    case "break_end":
      return { kind: "break_end" };
    case "replay_entrance": {
      const matchId = get("match_id");
      return matchId ? { kind: "replay_entrance", matchId } : null;
    }
    case "ceremony_next":
      return { kind: "ceremony", move: "next" };
    case "ceremony_back":
      return { kind: "ceremony", move: "back" };
    case "ceremony_replay":
      return { kind: "ceremony", move: "replay" };
    case "ceremony_restart":
      return { kind: "ceremony", move: "restart" };
    default:
      return null;
  }
}

export interface CommandContext {
  nowMs: number;
  /** The index of the ceremony's last step for this screen; 0 when there is nothing to reveal. */
  ceremonyLastStep: number;
  /** A live or paused match's court, by match id. Anything else is not replayable. */
  liveMatchCourt: (matchId: string) => string | null | undefined;
  /** The match's last scoring event number, so a replay ends only on a later point. */
  liveMatchEvent?: (matchId: string) => number;
  /** How many courts this screen covers, which decides whether its cards are big enough for an entrance. */
  coveredCourtCount?: number;
  isChess?: boolean;
  /** For a ceremony move pushed from the control room: the step the operator's view showed. */
  expectedCeremonyStep?: number;
}

export type Resolved =
  | { ok: true; patch: ScreenPatch }
  | { ok: false; reason: string; conflict?: boolean };

export function resolveScreenCommand(command: ScreenCommand, screen: ScreenSettings, ctx: CommandContext): Resolved {
  const nowIso = new Date(ctx.nowMs).toISOString();
  switch (command.kind) {
    case "mute":
      return { ok: true, patch: { mute_animations: command.on } };

    case "break_start":
      return {
        ok: true,
        patch: {
          break_started_at: nowIso,
          break_ends_at: new Date(ctx.nowMs + command.minutes * 60_000).toISOString(),
        },
      };

    case "break_end":
      return { ok: true, patch: { break_started_at: null, break_ends_at: null } };

    case "replay_entrance": {
      const court = ctx.liveMatchCourt(command.matchId);
      if (court === undefined) return { ok: false, reason: "that match is not live" };
      // Refused wherever the wall could not actually play it, so "On air" is never
      // reported for an entrance nobody will see.
      const reason = replayUnavailable(screen, court, ctx);
      if (reason) return { ok: false, reason };
      return {
        ok: true,
        patch: {
          entrance_replay: {
            match_id: command.matchId,
            at: nowIso,
            // The score as it stood when the operator pressed. A point already on
            // its way to the wall must not cancel the replay the moment it arrives;
            // only a later one ends it.
            event_number: ctx.liveMatchEvent?.(command.matchId) ?? 0,
          },
        },
      };
    }

    case "ceremony": {
      if (normalizeDisplayMode(screen.display_mode) !== "ceremony") {
        // Moving a ceremony nobody can see would start it part-way through later.
        return { ok: false, reason: "it is not showing the ceremony" };
      }
      if (ctx.expectedCeremonyStep !== undefined && ctx.expectedCeremonyStep !== (screen.ceremony_step ?? 0)) {
        // A relative move is not safe to repeat: pressed from a view that was one
        // step behind, it would skip a reveal someone else just made.
        return { ok: false, reason: "someone moved its ceremony a moment ago", conflict: true };
      }
      const last = Math.max(0, ctx.ceremonyLastStep);
      const current = Math.min(Math.max(0, screen.ceremony_step ?? 0), last);
      const step =
        command.move === "next"
          ? Math.min(last, current + 1)
          : command.move === "back"
            ? Math.max(0, current - 1)
            : command.move === "restart"
              ? 0
              : current;
      // Every move re-stamps, including a NEXT at the last step and a replay:
      // the stamp is what makes the wall play that step's build again.
      return { ok: true, patch: { ceremony_step: step, ceremony_step_at: nowIso } };
    }
  }
}

/**
 * Why the wall could not play a replayed entrance for a match on `court`, or null
 * when it can. Mirrors what the wall draws: live courts only, one card per court
 * the screen covers (only the pinned one when pinned), big enough for photos, and
 * moving at all.
 */
export function replayUnavailable(
  screen: Pick<ScreenSettings, "display_mode" | "court_ids" | "focus_court_id" | "mute_animations">,
  court: string | null,
  ctx: Pick<CommandContext, "coveredCourtCount" | "isChess">,
): string | null {
  if (normalizeDisplayMode(screen.display_mode) !== "live") return "it is not showing live courts";
  if (ctx.isChess) return "chess boards have no player entrance";
  if (!court) return "that match has no court, so no card shows it";
  if (screen.court_ids?.length && !screen.court_ids.includes(court)) return "that court is not on it";
  if (screen.focus_court_id && screen.focus_court_id !== court) return "it is pinned to another court";
  if (screen.mute_animations) return "its animations are muted";
  if (!screen.focus_court_id && ctx.coveredCourtCount !== undefined && !showsAt(planGrid(ctx.coveredCourtCount).density).entrance) {
    return "its court cards are too small for an entrance";
  }
  return null;
}

/**
 * Side effects of changing what a screen shows.
 *
 * Putting the ceremony on air starts it from its opening slate rather than from
 * wherever it was left last time, so the first reveal is never skipped. Changing
 * which podiums it shows while it is on air does the same: the stored step is a
 * position in the old sequence, and kept it could land straight on a champion
 * nobody has revealed yet.
 */
export function modeChangeEffects(
  patch: ScreenPatch,
  screen: Pick<ScreenSettings, "display_mode" | "bracket_tier">,
  nowMs: number,
  opts: { plateBracketPublished?: boolean } = {},
): ScreenPatch {
  // With two brackets the ceremony honours the Plate first, then the Cup, and the
  // bracket scene shows both trees side by side — unless whoever put it on air
  // chose otherwise in the same save. Without this the Plate is published and
  // simply never appears, because a screen's stored tier was decided before it
  // existed.
  if (
    opts.plateBracketPublished &&
    (patch.display_mode === "ceremony" || patch.display_mode === "bracket") &&
    screen.display_mode !== patch.display_mode &&
    patch.bracket_tier === undefined
  ) {
    patch = { ...patch, bracket_tier: "both" };
  }
  const nextMode = patch.display_mode ?? screen.display_mode;
  const entering = patch.display_mode === "ceremony" && screen.display_mode !== "ceremony";
  const tierChangedOnAir =
    nextMode === "ceremony" && patch.bracket_tier !== undefined && patch.bracket_tier !== screen.bracket_tier;
  if (entering || tierChangedOnAir) {
    return { ...patch, ceremony_step: 0, ceremony_step_at: new Date(nowMs).toISOString() };
  }
  return patch;
}

/** Whole seconds left in a break, from the server-anchored clock. Zero once it is over. */
export function breakRemainingSeconds(breakEndsAt: string | null | undefined, nowMs: number): number | null {
  if (!breakEndsAt) return null;
  const ends = Date.parse(breakEndsAt);
  if (!Number.isFinite(ends)) return null;
  return Math.max(0, Math.ceil((ends - nowMs) / 1000));
}

/** "4:05", "12:00", "0:00". */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Whole minutes left in a break, rounded up, as of the server's clock now. Null when not on break. */
export function breakMinutesLeft(breakEndsAt: string | null | undefined, nowMs: number = Date.now()): number | null {
  const seconds = breakRemainingSeconds(breakEndsAt, nowMs);
  return seconds === null ? null : Math.ceil(seconds / 60);
}

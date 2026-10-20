/**
 * What an alert says, and who it is for. Pure, so the wording is tested and the
 * same everywhere. The server stores the result in the outbox at the moment the
 * thing happens; the sender only resolves phones.
 */
import type { MAlertPrefs } from "../mobile/contract";

export type AlertKind =
  | "tie_scheduled"
  | "tie_rescheduled"
  | "tie_starting"
  | "lineups"
  | "match_scheduled"
  | "match_live"
  | "match_finished"
  | "tie_decided"
  | "announcement"
  /** Match day (Phase 3): the match before yours on the court is one game from the end. */
  | "match_soon"
  /** Match day: your match is called to its court. */
  | "called_to_court"
  /** Match day: the deadline to reach the court is close. */
  | "call_reminder"
  /** National team coaches (migration 0037): their own team only, to the phones signed in with its code. */
  | "coach_soon"
  | "coach_called"
  | "coach_started"
  | "coach_finished"
  | "coach_tie_result"
  | "coach_lineup";

/** Which alert switch on the phone governs each kind. */
export const CATEGORY: Record<AlertKind, keyof MAlertPrefs> = {
  tie_scheduled: "scheduled",
  tie_rescheduled: "scheduled",
  match_scheduled: "scheduled",
  lineups: "scheduled",
  tie_starting: "starting",
  match_live: "live",
  match_finished: "finished",
  tie_decided: "tie",
  announcement: "major",
  match_soon: "court",
  called_to_court: "court",
  call_reminder: "court",
  coach_soon: "starting",
  coach_called: "court",
  coach_started: "live",
  coach_finished: "finished",
  coach_tie_result: "tie",
  coach_lineup: "scheduled",
};

export interface Target {
  /**
   * "all" (key "all") is every phone with alerts on: a console announcement to all app users.
   * "coach_team" (key: teams.id, migration 0037): the phones signed in with that team's coach code.
   */
  kind: "player" | "nation" | "tie" | "match" | "tournament" | "event_group" | "all" | "coach_team";
  key: string;
}

export interface AlertPayload {
  title: string;
  body: string;
  /** Deep link the app opens: movescore://… */
  url: string;
  targets: Target[];
  category: keyof MAlertPrefs;
  /**
   * Wording for the players themselves. Phones signed in to an account linked to
   * one of `playerIds` (player_claims) get this alert too, whether or not they
   * follow anything, and read `title`/`body` here instead of the general one.
   * Player row ids only: never a phone, email or code.
   */
  self?: SelfWording;
}

export interface SelfWording {
  playerIds: string[];
  title: string;
  body: string;
}

export interface Side {
  name: string;
  code: string | null;
}

/** "14:30" in the event's own time zone, with the zone named when it differs from the phone's. */
export function localTime(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

export function localDay(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short" }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

const vs = (a: Side, b: Side) => `${a.code ?? a.name} v ${b.code ?? b.name}`;

export function composeTieSchedule(o: {
  kind: "tie_scheduled" | "tie_rescheduled";
  tieId: string;
  tournamentId: string;
  a: Side;
  b: Side;
  court: string | null;
  at: string | null;
  timeZone: string;
  eventName: string;
}): AlertPayload {
  const when = o.at ? `${localDay(o.at, o.timeZone)}, ${localTime(o.at, o.timeZone)} (${cityOf(o.timeZone)} time)` : "time to be announced";
  return {
    title: o.kind === "tie_rescheduled" ? `Moved: ${vs(o.a, o.b)}` : `Scheduled: ${vs(o.a, o.b)}`,
    body: `${o.court ?? "Court to be announced"} · ${when} · ${o.eventName}`,
    url: `movescore://tie/${o.tieId}`,
    targets: [
      { kind: "tie", key: o.tieId },
      ...nationTargets(o.a, o.b),
    ],
    category: CATEGORY[o.kind],
  };
}

export function composeTieStarting(o: { tieId: string; a: Side; b: Side; court: string | null; at: string; timeZone: string }): AlertPayload {
  return {
    title: `Starting soon: ${vs(o.a, o.b)}`,
    body: `${o.court ?? "Court to be announced"} at ${localTime(o.at, o.timeZone)}`,
    url: `movescore://tie/${o.tieId}`,
    targets: [{ kind: "tie", key: o.tieId }, ...nationTargets(o.a, o.b)],
    category: "starting",
  };
}

export function composeLineups(o: { tieId: string; a: Side; b: Side; rubbers: { label: string; a: string; b: string }[] }): AlertPayload {
  return {
    title: `Line-ups: ${vs(o.a, o.b)}`,
    body: o.rubbers.map((r) => `${r.label}: ${r.a} v ${r.b}`).join(" · ").slice(0, 170),
    url: `movescore://tie/${o.tieId}`,
    targets: [{ kind: "tie", key: o.tieId }, ...nationTargets(o.a, o.b)],
    category: "scheduled",
  };
}

export function composeMatchLive(o: {
  matchId: string;
  tieId: string | null;
  label: string;
  a: string;
  b: string;
  court: string | null;
  playerIds: string[];
  nations: Side[];
}): AlertPayload {
  return {
    title: `Live now: ${o.a} v ${o.b}`,
    body: `${o.label}${o.court ? ` · ${o.court}` : ""}`,
    url: `movescore://match/${o.matchId}`,
    targets: [
      { kind: "match", key: o.matchId },
      ...(o.tieId ? [{ kind: "tie" as const, key: o.tieId }] : []),
      ...o.playerIds.map((key) => ({ kind: "player" as const, key })),
    ],
    category: "live",
  };
}

export function composeMatchFinished(o: {
  matchId: string;
  tieId: string | null;
  label: string;
  winner: string;
  loser: string;
  score: string;
  playerIds: string[];
}): AlertPayload {
  return {
    title: `${o.winner} won`,
    body: `${o.score ? `${o.score} ` : ""}against ${o.loser} · ${o.label}`.trim(),
    url: `movescore://match/${o.matchId}`,
    targets: [
      { kind: "match", key: o.matchId },
      ...(o.tieId ? [{ kind: "tie" as const, key: o.tieId }] : []),
      ...o.playerIds.map((key) => ({ kind: "player" as const, key })),
    ],
    category: "finished",
  };
}

export function composeTieDecided(o: { tieId: string; winner: Side; loser: Side; rubbers: string; stageLabel: string }): AlertPayload {
  return {
    title: `${o.winner.name} beat ${o.loser.name} ${o.rubbers}`,
    body: o.stageLabel,
    url: `movescore://tie/${o.tieId}`,
    targets: [{ kind: "tie", key: o.tieId }, ...nationTargets(o.winner, o.loser)],
    category: "tie",
  };
}

export function composeAnnouncement(o: { id: string; title: string; body: string | null; tournamentId: string | null; tournamentSlug?: string | null; eventGroupId: string | null }): AlertPayload {
  return {
    title: o.title,
    body: o.body ?? "",
    url: o.tournamentSlug ? `movescore://t/${o.tournamentSlug}` : "movescore://discover",
    targets: [
      ...(o.tournamentId ? [{ kind: "tournament" as const, key: o.tournamentId }] : []),
      ...(o.eventGroupId ? [{ kind: "event_group" as const, key: o.eventGroupId }] : []),
    ],
    category: "major",
  };
}

function nationTargets(...sides: Side[]): Target[] {
  return sides.filter((s) => s.code && /^[A-Z]{3}$/.test(s.code)).map((s) => ({ kind: "nation" as const, key: s.code! }));
}

function cityOf(timeZone: string): string {
  return timeZone.split("/").pop()!.replace(/_/g, " ");
}

/* ---------------- league nights (Phase 8) ---------------- */

/**
 * A night's table is out: this match's court, its place in the court's order of
 * play and its estimated start ("about 19:40"; matches start when the court is
 * free). For the players only (`self`): nobody else is targeted.
 */
export function composeNightMatch(o: {
  matchId: string;
  a: Side;
  b: Side;
  court: string | null;
  position: number | null;
  /** "about 19:40", or null when the night has no start time. */
  about: string | null;
  eventName: string;
  playerIds: string[];
}): AlertPayload {
  const court = o.court ?? "Court to be announced";
  const when = o.about ?? "time to be announced";
  const place = o.position ? ` · match ${o.position} on ${court}` : "";
  const title = `Your table: ${court}, ${when}`;
  const body = `${o.a.name} v ${o.b.name}${place} · ${o.eventName}`;
  return {
    title,
    body,
    url: `movescore://match/${o.matchId}`,
    targets: [],
    category: CATEGORY.match_scheduled,
    self: { playerIds: o.playerIds, title, body },
  };
}

/* ---------------- match day (Phase 3) ---------------- */

export interface CourtMatch {
  matchId: string;
  /** Side labels as the alerts name them: "Team A", or "Popa / Grant (ROU)" in a rubber. */
  a: string;
  b: string;
  court: string;
  /** Round or event name. */
  label: string;
}

/**
 * The match before this one on its court is one game from the end. Sent to this
 * match's own players (`self`) and to the people who follow one of them (a
 * player follow is a choice to hear about that player's matches); starred fans
 * (the match's followers) only when the organiser turned that on.
 */
export function composeMatchSoon(o: CourtMatch & { playerIds: string[]; starredFans: boolean }): AlertPayload {
  return {
    title: `Next on ${o.court}: ${o.a} v ${o.b}`,
    body: `The match on court is one game from the end · ${o.label}`,
    url: `movescore://match/${o.matchId}`,
    targets: [...(o.starredFans ? [{ kind: "match" as const, key: o.matchId }] : []), ...o.playerIds.map((key) => ({ kind: "player" as const, key }))],
    category: CATEGORY.match_soon,
    self: {
      playerIds: o.playerIds,
      title: `You're next on ${o.court}`,
      body: `${o.a} v ${o.b}: the match on court is one game from the end. Get ready.`,
    },
  };
}

/** Called to court: the players have until `deadline` (shown in the event's zone). */
export function composeCalledToCourt(o: CourtMatch & { playerIds: string[]; deadline: string; timeZone: string; minutes: number }): AlertPayload {
  const by = localTime(o.deadline, o.timeZone);
  return {
    title: `Called to ${o.court}: ${o.a} v ${o.b}`,
    body: `Players to the court by ${by} · ${o.label}`,
    url: `movescore://match/${o.matchId}`,
    targets: [],
    category: CATEGORY.called_to_court,
    self: {
      playerIds: o.playerIds,
      title: `You're called to ${o.court}`,
      body: `${o.a} v ${o.b}: be at the court by ${by} (${o.minutes} min).`,
    },
  };
}

/** The deadline is close and these players are not at the court yet. */
export function composeCallReminder(o: CourtMatch & { playerIds: string[]; deadline: string; timeZone: string; minutesLeft: number }): AlertPayload {
  const by = localTime(o.deadline, o.timeZone);
  const left = `${o.minutesLeft} min`;
  return {
    title: `${left} to reach ${o.court}`,
    body: `${o.a} v ${o.b} · players to the court by ${by}`,
    url: `movescore://match/${o.matchId}`,
    targets: [],
    category: CATEGORY.call_reminder,
    self: {
      playerIds: o.playerIds,
      title: `${left} left to reach ${o.court}`,
      body: `${o.a} v ${o.b}: be at the court by ${by}, or the referee may record a no-show.`,
    },
  };
}

/** The reminder fires this long before the scheduled start. */
export const STARTING_LEAD_MINUTES = 15;

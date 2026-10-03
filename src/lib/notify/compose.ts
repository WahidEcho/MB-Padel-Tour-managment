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
  | "announcement";

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
};

export interface Target {
  /** "all" (key "all") is every phone with alerts on: a console announcement to all app users. */
  kind: "player" | "nation" | "tie" | "match" | "tournament" | "event_group" | "all";
  key: string;
}

export interface AlertPayload {
  title: string;
  body: string;
  /** Deep link the app opens: movescore://… */
  url: string;
  targets: Target[];
  category: keyof MAlertPrefs;
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

/** The reminder fires this long before the scheduled start. */
export const STARTING_LEAD_MINUTES = 15;

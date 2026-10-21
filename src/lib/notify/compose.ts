/**
 * What an alert says, and who it is for. Pure, so the wording is tested and the
 * same everywhere. The server stores the result in the outbox at the moment the
 * thing happens; the sender only resolves phones.
 */
import type { MAlertPrefs } from "../mobile/contract";
import { aw, clock, dayIn, inEveryLanguage, labelIn, statusWord, vsIn, type AlertLang, type AlertTranslations, type AlertWords } from "./i18n";

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
  /**
   * The same alert in Spanish and French (./i18n.ts), for phones whose app speaks
   * them (push_devices.locale). `title`/`body`/`self` above are the English. Absent
   * on alerts written by people (announcements): those go out as written.
   */
  tr?: AlertTranslations;
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

/** "14:30" in the event's own time zone. */
export function localTime(iso: string, timeZone: string): string {
  return clock(iso, timeZone);
}

export function localDay(iso: string, timeZone: string): string {
  return dayIn("en", iso, timeZone);
}

const vs = (lang: AlertLang, a: Side, b: Side) => vsIn(lang, a.code ?? a.name, b.code ?? b.name);

/**
 * An alert in every language: `build` writes it in one; the English becomes the
 * row's own words and the rest go to `tr`. `selfIds` keeps the players' own
 * wording (`build(...).self`) as `payload.self`.
 */
function localized(build: (lang: AlertLang) => AlertWords, rest: Omit<AlertPayload, "title" | "body" | "self" | "tr">, selfIds?: string[]): AlertPayload {
  const { en, tr } = inEveryLanguage(build);
  return {
    title: en.title,
    body: en.body,
    ...rest,
    ...(selfIds && en.self ? { self: { playerIds: selfIds, title: en.self.title, body: en.self.body } } : {}),
    tr,
  };
}

function scheduleWhen(lang: AlertLang, at: string | null, timeZone: string): string {
  return at ? aw(lang, "whenAt", { day: dayIn(lang, at, timeZone), time: clock(at, timeZone), city: cityOf(timeZone) }) : aw(lang, "timeTba");
}

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
  return localized(
    (lang) => ({
      title: aw(lang, o.kind === "tie_rescheduled" ? "moved" : "scheduled", { vs: vs(lang, o.a, o.b) }),
      body: aw(lang, "scheduleBody", { court: o.court ?? aw(lang, "courtTba"), when: scheduleWhen(lang, o.at, o.timeZone), event: o.eventName }),
    }),
    {
      url: `movescore://tie/${o.tieId}`,
      targets: [{ kind: "tie", key: o.tieId }, ...nationTargets(o.a, o.b)],
      category: CATEGORY[o.kind],
    },
  );
}

/** A single match's court and time (not a tie): its followers and its players. */
export function composeMatchScheduled(o: {
  matchId: string;
  a: Side;
  b: Side;
  court: string | null;
  at: string | null;
  timeZone: string;
  eventName: string;
  playerIds: string[];
}): AlertPayload {
  return localized(
    (lang) => ({
      title: aw(lang, "courtAndTime", { vs: vsIn(lang, o.a.name, o.b.name) }),
      body: aw(lang, "scheduleBody", { court: o.court ?? aw(lang, "courtTba"), when: scheduleWhen(lang, o.at, o.timeZone), event: o.eventName }),
    }),
    {
      url: `movescore://match/${o.matchId}`,
      targets: [{ kind: "match", key: o.matchId }, ...o.playerIds.map((key) => ({ kind: "player" as const, key }))],
      category: CATEGORY.tie_rescheduled,
    },
  );
}

export function composeTieStarting(o: { tieId: string; a: Side; b: Side; court: string | null; at: string; timeZone: string }): AlertPayload {
  return localized(
    (lang) => ({
      title: aw(lang, "startingSoon", { vs: vs(lang, o.a, o.b) }),
      body: aw(lang, "courtAt", { court: o.court ?? aw(lang, "courtTba"), time: clock(o.at, o.timeZone) }),
    }),
    { url: `movescore://tie/${o.tieId}`, targets: [{ kind: "tie", key: o.tieId }, ...nationTargets(o.a, o.b)], category: "starting" },
  );
}

export function composeLineups(o: { tieId: string; a: Side; b: Side; rubbers: { label: string; a: string; b: string }[] }): AlertPayload {
  return localized(
    (lang) => ({
      title: aw(lang, "lineups", { vs: vs(lang, o.a, o.b) }),
      body: o.rubbers
        .map((r) => `${aw(lang, "line", { label: labelIn(lang, r.label) })}${vsIn(lang, r.a === "TBD" ? aw(lang, "tbd") : r.a, r.b === "TBD" ? aw(lang, "tbd") : r.b)}`)
        .join(" · ")
        .slice(0, 170),
    }),
    { url: `movescore://tie/${o.tieId}`, targets: [{ kind: "tie", key: o.tieId }, ...nationTargets(o.a, o.b)], category: "scheduled" },
  );
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
  return localized(
    (lang) => ({
      title: aw(lang, "liveNow", { vs: vsIn(lang, o.a, o.b) }),
      body: `${labelIn(lang, o.label)}${o.court ? ` · ${o.court}` : ""}`,
    }),
    {
      url: `movescore://match/${o.matchId}`,
      targets: [
        { kind: "match", key: o.matchId },
        ...(o.tieId ? [{ kind: "tie" as const, key: o.tieId }] : []),
        ...o.playerIds.map((key) => ({ kind: "player" as const, key })),
      ],
      category: "live",
    },
  );
}

/** `score` is the sets ("6–4 6–4"), or the match's status when it did not end on the court ("walkover"). */
export function composeMatchFinished(o: {
  matchId: string;
  tieId: string | null;
  label: string;
  winner: string;
  loser: string;
  score: string;
  playerIds: string[];
}): AlertPayload {
  return localized(
    (lang) => {
      const score = /^[a-z_]+$/.test(o.score) ? statusWord(lang, o.score) : o.score;
      return {
        title: aw(lang, "won", { winner: o.winner }),
        body: aw(lang, score ? "wonBody" : "wonBodyNoScore", { score, loser: o.loser, label: labelIn(lang, o.label) }).trim(),
      };
    },
    {
      url: `movescore://match/${o.matchId}`,
      targets: [
        { kind: "match", key: o.matchId },
        ...(o.tieId ? [{ kind: "tie" as const, key: o.tieId }] : []),
        ...o.playerIds.map((key) => ({ kind: "player" as const, key })),
      ],
      category: "finished",
    },
  );
}

export function composeTieDecided(o: { tieId: string; winner: Side; loser: Side; rubbers: string; stageLabel: string }): AlertPayload {
  return localized(
    (lang) => ({ title: aw(lang, "beat", { winner: o.winner.name, loser: o.loser.name, rubbers: o.rubbers }), body: labelIn(lang, o.stageLabel) }),
    { url: `movescore://tie/${o.tieId}`, targets: [{ kind: "tie", key: o.tieId }, ...nationTargets(o.winner, o.loser)], category: "tie" },
  );
}

/** Written by a person (Announcements, play status): goes out as written, or with the translations given. */
export function composeAnnouncement(o: {
  id: string;
  title: string;
  body: string | null;
  tournamentId: string | null;
  tournamentSlug?: string | null;
  eventGroupId: string | null;
  tr?: AlertTranslations;
}): AlertPayload {
  return {
    title: o.title,
    body: o.body ?? "",
    url: o.tournamentSlug ? `movescore://t/${o.tournamentSlug}` : "movescore://discover",
    targets: [
      ...(o.tournamentId ? [{ kind: "tournament" as const, key: o.tournamentId }] : []),
      ...(o.eventGroupId ? [{ kind: "event_group" as const, key: o.eventGroupId }] : []),
    ],
    category: "major",
    ...(o.tr ? { tr: o.tr } : {}),
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
  const build = (lang: AlertLang): AlertWords => {
    const court = o.court ?? aw(lang, "courtTba");
    const about = o.about ? /^about (\d\d:\d\d)$/.exec(o.about) : null;
    const when = o.about ? (about ? aw(lang, "about", { time: about[1] }) : o.about) : aw(lang, "timeTba");
    const place = o.position ? aw(lang, "nightPlace", { n: o.position, court }) : "";
    const title = aw(lang, "yourTable", { court, when });
    const body = aw(lang, "nightBody", { vs: vsIn(lang, o.a.name, o.b.name), place, event: o.eventName });
    return { title, body, self: { title, body } };
  };
  return localized(build, { url: `movescore://match/${o.matchId}`, targets: [], category: CATEGORY.match_scheduled }, o.playerIds);
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
  return localized(
    (lang) => {
      const pair = vsIn(lang, o.a, o.b);
      return {
        title: aw(lang, "nextOn", { court: o.court, vs: pair }),
        body: aw(lang, "nextOnBody", { label: labelIn(lang, o.label) }),
        self: { title: aw(lang, "youNext", { court: o.court }), body: aw(lang, "youNextBody", { vs: pair }) },
      };
    },
    {
      url: `movescore://match/${o.matchId}`,
      targets: [...(o.starredFans ? [{ kind: "match" as const, key: o.matchId }] : []), ...o.playerIds.map((key) => ({ kind: "player" as const, key }))],
      category: CATEGORY.match_soon,
    },
    o.playerIds,
  );
}

/** Called to court: the players have until `deadline` (shown in the event's zone). */
export function composeCalledToCourt(o: CourtMatch & { playerIds: string[]; deadline: string; timeZone: string; minutes: number }): AlertPayload {
  const by = localTime(o.deadline, o.timeZone);
  return localized(
    (lang) => {
      const pair = vsIn(lang, o.a, o.b);
      return {
        title: aw(lang, "calledTo", { court: o.court, vs: pair }),
        body: aw(lang, "calledToBody", { by, label: labelIn(lang, o.label) }),
        self: { title: aw(lang, "youCalled", { court: o.court }), body: aw(lang, "youCalledBody", { vs: pair, by, minutes: o.minutes }) },
      };
    },
    { url: `movescore://match/${o.matchId}`, targets: [], category: CATEGORY.called_to_court },
    o.playerIds,
  );
}

/** The deadline is close and these players are not at the court yet. */
export function composeCallReminder(o: CourtMatch & { playerIds: string[]; deadline: string; timeZone: string; minutesLeft: number }): AlertPayload {
  const by = localTime(o.deadline, o.timeZone);
  return localized(
    (lang) => {
      const pair = vsIn(lang, o.a, o.b);
      return {
        title: aw(lang, "minLeftTo", { minutes: o.minutesLeft, court: o.court }),
        body: aw(lang, "minLeftToBody", { vs: pair, by }),
        self: { title: aw(lang, "youMinLeft", { minutes: o.minutesLeft, court: o.court }), body: aw(lang, "youMinLeftBody", { vs: pair, by }) },
      };
    },
    { url: `movescore://match/${o.matchId}`, targets: [], category: CATEGORY.call_reminder },
    o.playerIds,
  );
}

/** The reminder fires this long before the scheduled start. */
export const STARTING_LEAD_MINUTES = 15;

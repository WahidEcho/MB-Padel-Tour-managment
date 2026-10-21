/**
 * What a national team coach's phone is told (migration 0037), and only about their own
 * team. Pure: the hooks (src/lib/notify/hooks.ts) store one outbox row per team, targeted
 * at `coach_team:<team id>`, which the drain resolves to the phones signed in with that
 * team's working code. Never another team's line-up: a line-up alert names the coach's own
 * players only.
 */
import { localTime, type AlertPayload } from "../notify/compose";
import { aw, inEveryLanguage, labelIn, statusWord, vsIn, type AlertLang, type AlertWords } from "../notify/i18n";
import type { CoachAlertKind } from "./rules";

export interface CoachTeamLabel {
  teamId: string;
  /** "EGY" (or the team's name). */
  code: string;
}

const CATEGORY: Record<CoachAlertKind, AlertPayload["category"]> = {
  coach_soon: "starting",
  coach_called: "court",
  coach_started: "live",
  coach_finished: "finished",
  coach_tie_result: "tie",
  coach_lineup: "scheduled",
};

/** One alert in every language (../notify/i18n.ts): English in title/body, Spanish and French in `tr`. */
function payload(kind: CoachAlertKind, teamId: string, build: (lang: AlertLang) => AlertWords, url: string): AlertPayload {
  const cut = (w: AlertWords): AlertWords => ({ title: w.title.slice(0, 120), body: w.body.slice(0, 240) });
  const { en, tr } = inEveryLanguage((lang) => cut(build(lang)));
  return { title: en.title, body: en.body, url, targets: [{ kind: "coach_team", key: teamId }], category: CATEGORY[kind], tr };
}

const tieUrl = (tieId: string) => `movescore://coach/tie/${tieId}`;
const matchUrl = (matchId: string) => `movescore://coach/match/${matchId}`;
const vs = (lang: AlertLang, us: CoachTeamLabel, them: string | null) => vsIn(lang, us.code, them ?? aw(lang, "tbd"));

/** The tie starts in about five minutes. */
export function coachTieSoon(o: { us: CoachTeamLabel; them: string | null; tieId: string; court: string | null; at: string; timeZone: string; stage: string }): AlertPayload {
  return payload(
    "coach_soon",
    o.us.teamId,
    (lang) => ({
      title: aw(lang, "coachTieSoon", { vs: vs(lang, o.us, o.them) }),
      body: aw(lang, "coachTieSoonBody", { court: o.court ?? aw(lang, "courtTba"), time: localTime(o.at, o.timeZone), stage: labelIn(lang, o.stage) }),
    }),
    tieUrl(o.tieId),
  );
}

/** The rubber is next on its court (the match on court is one game from the end). */
export function coachRubberSoon(o: { us: CoachTeamLabel; them: string | null; matchId: string; court: string; label: string; players: string[] }): AlertPayload {
  return payload(
    "coach_soon",
    o.us.teamId,
    (lang) => ({
      title: aw(lang, "coachNextOn", { court: o.court, label: labelIn(lang, o.label), vs: vs(lang, o.us, o.them) }),
      body: o.players.length ? aw(lang, "coachNextOnBody", { players: o.players.join(" / ") }) : aw(lang, "coachNextOnBodyNone"),
    }),
    matchUrl(o.matchId),
  );
}

export function coachCalled(o: { us: CoachTeamLabel; them: string | null; matchId: string; court: string; label: string; players: string[]; deadline: string; timeZone: string }): AlertPayload {
  return payload(
    "coach_called",
    o.us.teamId,
    (lang) => ({
      title: aw(lang, "coachCalled", { court: o.court, label: labelIn(lang, o.label), vs: vs(lang, o.us, o.them) }),
      body: aw(lang, "coachCalledBody", { players: o.players.length ? o.players.join(" / ") : aw(lang, "players"), time: localTime(o.deadline, o.timeZone) }),
    }),
    matchUrl(o.matchId),
  );
}

export function coachStarted(o: { us: CoachTeamLabel; them: string | null; matchId: string; court: string | null; label: string; players: string[] }): AlertPayload {
  return payload(
    "coach_started",
    o.us.teamId,
    (lang) => ({
      title: aw(lang, "coachStarted", { label: labelIn(lang, o.label), vs: vs(lang, o.us, o.them) }),
      body: `${o.players.length ? `${o.players.join(" / ")} · ` : ""}${o.court ?? aw(lang, "onCourt")}`,
    }),
    matchUrl(o.matchId),
  );
}

/** `score` is the coach's team first ("6–4 3–6 [10–7]"). */
export function coachFinished(o: { us: CoachTeamLabel; them: string | null; matchId: string; label: string; won: boolean; score: string; status: string }): AlertPayload {
  return payload(
    "coach_finished",
    o.us.teamId,
    (lang) => {
      const how = o.status === "completed" ? o.score : statusWord(lang, o.status);
      return {
        title: aw(lang, o.won ? "coachWon" : "coachLost", { label: labelIn(lang, o.label), vs: vs(lang, o.us, o.them) }),
        body: how || aw(lang, o.won ? "matchWon" : "matchLost"),
      };
    },
    matchUrl(o.matchId),
  );
}

/** `rubbers` is the coach's team first ("2–1"). */
export function coachTieResult(o: { us: CoachTeamLabel; them: string | null; tieId: string; won: boolean; rubbers: string; stage: string }): AlertPayload {
  return payload(
    "coach_tie_result",
    o.us.teamId,
    (lang) => ({
      title: aw(lang, o.won ? "coachBeat" : "coachLostTo", { us: o.us.code, them: o.them ?? aw(lang, "tbd"), rubbers: o.rubbers }),
      body: labelIn(lang, o.stage),
    }),
    tieUrl(o.tieId),
  );
}

/** The team's own line-up for a tie was entered or changed: their own players only. */
export function coachLineup(o: { us: CoachTeamLabel; them: string | null; tieId: string; rubbers: { label: string; players: string[] }[]; late: boolean }): AlertPayload {
  return payload(
    "coach_lineup",
    o.us.teamId,
    (lang) => {
      const lines = o.rubbers.filter((r) => r.players.length).map((r) => `${aw(lang, "line", { label: labelIn(lang, r.label) })}${r.players.join(" / ")}`);
      return {
        title: aw(lang, o.late ? "lineupChanged" : "lineupEntered", { vs: vs(lang, o.us, o.them) }),
        body: lines.join(" · ") || aw(lang, "lineupEnteredBody"),
      };
    },
    tieUrl(o.tieId),
  );
}

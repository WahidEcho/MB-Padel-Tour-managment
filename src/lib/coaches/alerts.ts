/**
 * What a national team coach's phone is told (migration 0037), and only about their own
 * team. Pure: the hooks (src/lib/notify/hooks.ts) store one outbox row per team, targeted
 * at `coach_team:<team id>`, which the drain resolves to the phones signed in with that
 * team's working code. Never another team's line-up: a line-up alert names the coach's own
 * players only.
 */
import { localTime, type AlertPayload } from "../notify/compose";
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

function payload(kind: CoachAlertKind, teamId: string, title: string, body: string, url: string): AlertPayload {
  return { title: title.slice(0, 120), body: body.slice(0, 240), url, targets: [{ kind: "coach_team", key: teamId }], category: CATEGORY[kind] };
}

const tieUrl = (tieId: string) => `movescore://coach/tie/${tieId}`;
const matchUrl = (matchId: string) => `movescore://coach/match/${matchId}`;
const vs = (us: CoachTeamLabel, them: string | null) => `${us.code} v ${them ?? "TBD"}`;

/** The tie starts in about five minutes. */
export function coachTieSoon(o: { us: CoachTeamLabel; them: string | null; tieId: string; court: string | null; at: string; timeZone: string; stage: string }): AlertPayload {
  return payload("coach_soon", o.us.teamId, `${vs(o.us, o.them)} starts in 5 minutes`, `${o.court ?? "Court to be announced"} at ${localTime(o.at, o.timeZone)} · ${o.stage}`, tieUrl(o.tieId));
}

/** The rubber is next on its court (the match on court is one game from the end). */
export function coachRubberSoon(o: { us: CoachTeamLabel; them: string | null; matchId: string; court: string; label: string; players: string[] }): AlertPayload {
  return payload("coach_soon", o.us.teamId, `Next on ${o.court}: ${o.label} · ${vs(o.us, o.them)}`, `${o.players.length ? `${o.players.join(" / ")}: ` : ""}the match on court is one game from the end.`, matchUrl(o.matchId));
}

export function coachCalled(o: { us: CoachTeamLabel; them: string | null; matchId: string; court: string; label: string; players: string[]; deadline: string; timeZone: string }): AlertPayload {
  return payload("coach_called", o.us.teamId, `Called to ${o.court}: ${o.label} · ${vs(o.us, o.them)}`, `${o.players.length ? o.players.join(" / ") : "Players"} to the court by ${localTime(o.deadline, o.timeZone)}.`, matchUrl(o.matchId));
}

export function coachStarted(o: { us: CoachTeamLabel; them: string | null; matchId: string; court: string | null; label: string; players: string[] }): AlertPayload {
  return payload("coach_started", o.us.teamId, `Started: ${o.label} · ${vs(o.us, o.them)}`, `${o.players.length ? `${o.players.join(" / ")} · ` : ""}${o.court ?? "on court"}`, matchUrl(o.matchId));
}

/** `score` is the coach's team first ("6–4 3–6 [10–7]"). */
export function coachFinished(o: { us: CoachTeamLabel; them: string | null; matchId: string; label: string; won: boolean; score: string; status: string }): AlertPayload {
  const how = o.status === "completed" ? o.score : o.status;
  return payload("coach_finished", o.us.teamId, `${o.won ? "Won" : "Lost"}: ${o.label} · ${vs(o.us, o.them)}`, how || (o.won ? "Match won" : "Match lost"), matchUrl(o.matchId));
}

/** `rubbers` is the coach's team first ("2–1"). */
export function coachTieResult(o: { us: CoachTeamLabel; them: string | null; tieId: string; won: boolean; rubbers: string; stage: string }): AlertPayload {
  return payload("coach_tie_result", o.us.teamId, o.won ? `${o.us.code} beat ${o.them ?? "TBD"} ${o.rubbers}` : `${o.us.code} lost to ${o.them ?? "TBD"} ${o.rubbers}`, o.stage, tieUrl(o.tieId));
}

/** The team's own line-up for a tie was entered or changed: their own players only. */
export function coachLineup(o: { us: CoachTeamLabel; them: string | null; tieId: string; rubbers: { label: string; players: string[] }[]; late: boolean }): AlertPayload {
  const lines = o.rubbers.filter((r) => r.players.length).map((r) => `${r.label}: ${r.players.join(" / ")}`);
  return payload("coach_lineup", o.us.teamId, `${o.late ? "Line-up changed" : "Line-up entered"}: ${vs(o.us, o.them)}`, lines.join(" · ") || "Line-up entered", tieUrl(o.tieId));
}

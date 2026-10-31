/**
 * The toss before a tennis or padel match (owner, 31 Oct 2026), pure and shared with the app
 * through @core. The chair umpire records who won it and the choices, one question at a time:
 *
 *  - The winner chooses to serve, to receive, a side (end) of the court, or to let the opponent
 *    choose first ("defer").
 *  - Whoever chooses first makes one choice: serve / receive, or a side. The other player makes
 *    the remaining one (ITF Rules of Tennis, rule 4): after serve or receive, the side; after a
 *    side, serve or receive.
 *  - Sides are LEFT and RIGHT as the chair umpire sees the court from the chair. The consoles
 *    mirror the court with them and swap at every change of ends (timing.ts `leftTeamNow`).
 *
 * The result rides on MATCH_STARTED (payload `toss`, state `toss` and `leftAtStart`), so the match
 * log and the court TV can say it and every later state knows where each team stands.
 */
import { opponent, type ScoreState, type TeamKey } from "./engine";

export type TossChoice = "serve" | "receive" | "side";
export type CourtSide = "left" | "right";

/** The answers so far, in the order they are asked. */
export interface TossAnswers {
  winner?: TeamKey;
  /** The winner let the opponent choose first. */
  deferred?: boolean;
  /** The first choice, by the winner (or the opponent after a deferral). */
  first?: TossChoice;
  /** The side the first chooser took, when their choice was a side. */
  firstSide?: CourtSide;
  /** The second chooser's answer: serve or receive after a side, a side after serve or receive. */
  second?: "serve" | "receive" | CourtSide;
}

/** The toss as recorded: who won, who chose what, and what follows from it. */
export interface TossRecord {
  winner: TeamKey;
  deferred: boolean;
  /** The first chooser and their choice. */
  first: { team: TeamKey; choice: TossChoice; side?: CourtSide };
  /** The other team and what was left to them. */
  second: { team: TeamKey; choice: TossChoice; side?: CourtSide };
  servingTeam: TeamKey;
  /** The team on the chair umpire's left for the first game. */
  leftTeam: TeamKey;
}

export type TossQuestion =
  | { kind: "winner" }
  | { kind: "winnerChoice"; team: TeamKey }
  | { kind: "choice"; team: TeamKey }
  | { kind: "side"; team: TeamKey }
  | { kind: "serveOrReceive"; team: TeamKey };

/** The team that chooses first: the winner, or the opponent after a deferral. */
export function firstChooser(a: TossAnswers): TeamKey | null {
  if (!a.winner) return null;
  return a.deferred ? opponent(a.winner) : a.winner;
}

/** The next question, or null once the toss is complete. */
export function tossQuestion(a: TossAnswers): TossQuestion | null {
  if (!a.winner) return { kind: "winner" };
  const chooser = firstChooser(a)!;
  if (!a.first) return a.deferred ? { kind: "choice", team: chooser } : { kind: "winnerChoice", team: a.winner };
  if (a.first === "side" && !a.firstSide) return { kind: "side", team: chooser };
  if (!a.second) return a.first === "side" ? { kind: "serveOrReceive", team: opponent(chooser) } : { kind: "side", team: opponent(chooser) };
  return null;
}

/**
 * One answer: the winner, the winner's choice ("defer" included), the first chooser's choice
 * after a deferral, a side, or serve / receive. Answers after the one changed are dropped, so
 * going back and choosing differently never leaves a stale answer behind.
 */
export function answerToss(a: TossAnswers, q: TossQuestion, value: TeamKey | TossChoice | "defer" | CourtSide | "serve" | "receive"): TossAnswers {
  switch (q.kind) {
    case "winner":
      return { winner: value as TeamKey };
    case "winnerChoice":
      return value === "defer" ? { winner: a.winner, deferred: true } : { winner: a.winner, deferred: false, first: value as TossChoice };
    case "choice":
      return { winner: a.winner, deferred: true, first: value as TossChoice };
    case "side":
      if (a.first === "side" && !a.firstSide) return { winner: a.winner, deferred: a.deferred, first: a.first, firstSide: value as CourtSide };
      return { ...a, second: value as CourtSide };
    case "serveOrReceive":
      return { ...a, second: value as "serve" | "receive" };
  }
}

/** The finished toss, or null while a question is still open. */
export function tossRecord(a: TossAnswers): TossRecord | null {
  if (tossQuestion(a) !== null) return null;
  const winner = a.winner!;
  const c1 = firstChooser(a)!;
  const c2 = opponent(c1);
  if (a.first === "side") {
    const leftTeam = a.firstSide === "left" ? c1 : c2;
    const servingTeam = a.second === "serve" ? c2 : c1;
    return {
      winner,
      deferred: Boolean(a.deferred),
      first: { team: c1, choice: "side", side: a.firstSide },
      second: { team: c2, choice: a.second as "serve" | "receive" },
      servingTeam,
      leftTeam,
    };
  }
  const servingTeam = a.first === "serve" ? c1 : c2;
  const leftTeam = a.second === "left" ? c2 : c1;
  return {
    winner,
    deferred: Boolean(a.deferred),
    first: { team: c1, choice: a.first! },
    second: { team: c2, choice: "side", side: a.second as CourtSide },
    servingTeam,
    leftTeam,
  };
}

/** A stored toss (payload or state), checked: anything malformed reads as no toss. */
export function parseToss(raw: unknown): TossRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const team = (v: unknown): v is TeamKey => v === "A" || v === "B";
  const side = (v: unknown): v is CourtSide => v === "left" || v === "right";
  const choice = (v: unknown): v is TossChoice => v === "serve" || v === "receive" || v === "side";
  const part = (v: unknown) => {
    const p = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    if (!team(p.team) || !choice(p.choice)) return null;
    if (p.choice === "side" && !side(p.side)) return null;
    return { team: p.team, choice: p.choice, ...(side(p.side) ? { side: p.side } : {}) };
  };
  const first = part(t.first);
  const second = part(t.second);
  if (!team(t.winner) || !first || !second || first.team === second.team || !team(t.servingTeam) || !team(t.leftTeam)) return null;
  return { winner: t.winner, deferred: t.deferred === true, first, second, servingTeam: t.servingTeam, leftTeam: t.leftTeam };
}

/* ---------------- before the first point ---------------- */

/** Nothing has been played yet: the moment the court TV shows the toss. */
export function beforeFirstPoint(s: ScoreState | null | undefined): boolean {
  if (!s) return false;
  return (
    s.completedSets.length === 0 &&
    s.teamA.games + s.teamB.games === 0 &&
    s.teamA.points === "0" &&
    s.teamB.points === "0" &&
    s.teamA.tiebreakPoints + s.teamB.tiebreakPoints === 0
  );
}

/* ---------------- the toss in words (English: match log, TVs) ---------------- */

function choiceWords(c: { choice: TossChoice; side?: CourtSide }): string {
  if (c.choice === "side") return `the ${c.side} side`;
  return `to ${c.choice}`;
}

/** "Egypt won the toss and chose to serve; Spain took the left side." */
export function tossSentence(t: TossRecord, name: (k: TeamKey) => string): string {
  const head = t.deferred
    ? `${name(t.winner)} won the toss and let ${name(t.first.team)} choose. ${name(t.first.team)} chose ${choiceWords(t.first)}`
    : `${name(t.winner)} won the toss and chose ${choiceWords(t.first)}`;
  const tail = t.second.choice === "side" ? `${name(t.second.team)} took ${choiceWords(t.second)}` : `${name(t.second.team)} chose ${choiceWords(t.second)}`;
  return `${head}; ${tail}.`;
}

/** The short line on the court TV before the first point: "EGY won the toss · chose to serve". */
export function tossHeadline(t: TossRecord, code: (k: TeamKey) => string): string {
  if (t.deferred) return `${code(t.winner)} won the toss · ${code(t.first.team)} chose ${choiceWords(t.first)}`;
  return `${code(t.winner)} won the toss · chose ${choiceWords(t.first)}`;
}

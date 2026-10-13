import type { CallView, Match, MatchDayRules, MatchSnapshot, ScoringConfig, ScoringModeChoice } from "@core";

/** GET /api/mobile/v1/referee/matches/:id/bootstrap (src/lib/referee/bootstrap.ts). */
export interface RefereeSide {
  id: string;
  name: string;
  nation: string | null;
  iso2: string | null;
  checkedIn: boolean;
  players: { id: string; name: string }[];
}

export interface RefereeBootstrap {
  match: Match;
  tournament: { id: string; name: string; sport: string; timezone: string };
  courtName: string;
  config: ScoringConfig;
  tennis: boolean;
  chess: boolean;
  /** Chess: games per pairing. Absent from servers before Phase 5 (read as 1). */
  legs?: 1 | 2;
  waitingForLineups: string | null;
  sideA: RefereeSide | null;
  sideB: RefereeSide | null;
  snapshot: MatchSnapshot | null;
  reopenState: Record<string, unknown> | null;
  history: unknown[];
  redBlueTeams: boolean;
  lease: { deviceId: string; deviceLabel: string | null; expiresAt: string; isLive: boolean } | null;
  /** Absent from servers before match day (migration 0022). */
  matchDay?: MatchDayRules;
  scoringMode?: ScoringModeChoice;
  /** The match's call to court; null when never called. Absent from servers before match day. */
  call?: RefereeCall | null;
}

/**
 * A match's call to court, as the bootstrap and the call route send it
 * (CallState in src/lib/matchday/server.ts). No device ids, no player data.
 */
export interface RefereeCall {
  matchId: string;
  courtId: string | null;
  status: "called" | "started" | "walkover" | "cancelled";
  calledAt: string;
  deadlineAt: string;
  extensions: number;
  presentA: boolean;
  presentB: boolean;
  answer: { action: string; at: string; by: string } | null;
  /** The server's view when it answered; the phone recomputes it every second with the same rules. */
  view: CallView;
}

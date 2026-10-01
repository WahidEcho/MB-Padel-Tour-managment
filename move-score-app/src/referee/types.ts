import type { Match, MatchSnapshot, ScoringConfig } from "@core";

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
  waitingForLineups: string | null;
  sideA: RefereeSide | null;
  sideB: RefereeSide | null;
  snapshot: MatchSnapshot | null;
  reopenState: Record<string, unknown> | null;
  history: unknown[];
  redBlueTeams: boolean;
  lease: { deviceId: string; deviceLabel: string | null; expiresAt: string; isLive: boolean } | null;
}

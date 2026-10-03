/**
 * The one door to the web platform's shared code. Everything here is pure
 * TypeScript in ../src/lib (no database, no browser, no Next.js), so the app
 * scores a point with exactly the engine the server and the web console use.
 */
export * from "../../../src/lib/scoring/engine";
export * from "../../../src/lib/scoring/conduct";
export { scoringConfigForMatch, isDoublesMatch, describeMatchRules } from "../../../src/lib/scoring/rules";
export { batchProblem, sameState, SCORE_EVENT_TYPES, MAX_EVENTS_PER_BATCH } from "../../../src/lib/scoring/eventGuard";
export * from "../../../src/lib/mobile/contract";
export * from "../../../src/lib/mobile/alertsSwitch";
export { LEASE_TTL_MS, LEASE_RENEW_MS } from "../../../src/lib/scoringLease";
export { RUBBER_LABELS, RUBBER_SHORT } from "../../../src/lib/tennis/ties";
export { NATIONS, nationByCode } from "../../../src/lib/tennis/nations";
export { DEFAULT_SCORING_CONFIG } from "../../../src/lib/types";
export type { ScoringConfig, Match, MatchSnapshot, CompletedSet, MatchStatus } from "../../../src/lib/types";
export * as Console from "../../../src/lib/scoring/console";
export { OFFENCE_LABELS, PENALTY_LABELS } from "../../../src/lib/scoring/conduct";

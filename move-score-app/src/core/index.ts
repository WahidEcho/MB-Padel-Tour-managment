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
export * from "../../../src/lib/mobile/oauth";
export { LEASE_TTL_MS, LEASE_RENEW_MS, NO_LEASE_VIEW, nextLeaseView, claimedLeaseView, createLeaseOrder } from "../../../src/lib/scoringLease";
export type { LeaseSideView, SeenLease } from "../../../src/lib/scoringLease";
export { RUBBER_LABELS, RUBBER_SHORT } from "../../../src/lib/tennis/ties";
export { NATIONS, nationByCode } from "../../../src/lib/tennis/nations";
export { DEFAULT_SCORING_CONFIG } from "../../../src/lib/types";
export type { ScoringConfig, Match, MatchRules, MatchSnapshot, CompletedSet, MatchStatus } from "../../../src/lib/types";
export * as Console from "../../../src/lib/scoring/console";
export { OFFENCE_LABELS, PENALTY_LABELS } from "../../../src/lib/scoring/conduct";
export { normalizeAccessCode, formatAccessCode, isValidAccessCode, ACCESS_CODE_LENGTH } from "../../../src/lib/players/accessCode";
export { toE164, displayPhone } from "../../../src/lib/players/phone";
export { OTP_LENGTH, normalizeOneTimeCode } from "../../../src/lib/players/otp";
export * from "../../../src/lib/auth/password";
export { SITE_URL, SITE_HOST, APP_PAGE_URL } from "../../../src/lib/site";
export { isSessionRevoked, REFRESH_AHEAD_SECONDS, SESSION_REVOKED } from "../../../src/lib/auth/sessionRules";
export { SPORTS, sportOf } from "../../../src/lib/sports/registry";
export type { SportDef, SportEngine, SportNouns, SportSupports } from "../../../src/lib/sports/registry";
export { DEFAULT_MATCH_DAY_RULES, OFF_MATCH_DAY_RULES, matchDayRules, publicMatchDay, resolveScoringMode } from "../../../src/lib/matchday/rules";
export type { MatchDayRules, ScoringModeChoice } from "../../../src/lib/matchday/rules";
export { validateFinalScore, stateFromFinalScore, finalScoreSummary, enteredSetsFromState, setKindAt, matchTiebreakSet, completeTiebreak } from "../../../src/lib/scoring/finalScore";
export type { EnteredSet, FinalScoreProblem, FinalScoreProblemCode, FinalScoreBuild, FinalScoreSummary, SetKind } from "../../../src/lib/scoring/finalScore";
export { chessGamePoints, chessOutcome, chessStateFromResults, validateChessResults, chessScoreLine } from "../../../src/lib/chess/result";
export type { ChessGameResult, ChessCompetition, ChessOutcome, ChessAdvance, ChessResultProblem } from "../../../src/lib/chess/result";
export { RESULT_ENTERED, parseResultPayload, buildResultState, finalResultAllowed, chessCompetitionFor, resultProblemMessage } from "../../../src/lib/scoring/resultEntry";
export type { ResultPayload, GamesResultPayload, ChessResultPayload, ResultProblem, ResultProblemCode, ResultBuild } from "../../../src/lib/scoring/resultEntry";
export { queueableResult, resultRejection, resultPayloadOf } from "../../../src/lib/offline/finalResult";
export type { QueueableResult, ResultRejection, QueuedEventLike } from "../../../src/lib/offline/finalResult";
export { courtQueue, nextOnCourt, courtBusy } from "../../../src/lib/matchday/courtQueue";
export type { QueueMatch } from "../../../src/lib/matchday/courtQueue";
export { isNearEnd, nearEndCrossed, sidesOneGameFromWinning } from "../../../src/lib/matchday/nearEnd";
export { callView, callDeadline, callReminderAt, extendCall, reminderDue } from "../../../src/lib/matchday/call";
export type { CourtCall, CallPhase, CallAction, CallView, NoShowPrompt, ExtendRefusal } from "../../../src/lib/matchday/call";
export { callCardModel, noShowOptions, courtCallOf, callClock } from "../../../src/lib/matchday/callCard";
export type { CallSnapshot, CallCardModel, CallCardSide, NoShowChoice, NoShowOption } from "../../../src/lib/matchday/callCard";
export { DEFAULT_LEAGUE_POINTS_RULES, leaguePointsRules, resultMonth } from "../../../src/lib/leagues/points";
export type { LeaguePointsRules, LeagueStreakRule, LeagueResultKind, LeaguePointsRow } from "../../../src/lib/leagues/points";
export { BOARD_LENGTHS, boardMonths, rankBoard, monthlyBoard, periodBoard, topOfAllLeagues, boardLineOf } from "../../../src/lib/leagues/boards";
export type { BoardEntry, BoardLine, BoardLength, BoardLeague, TopScope } from "../../../src/lib/leagues/boards";
export { JOIN_MODES, joinDecision, normalizeJoinModes, normalizeInviteCode } from "../../../src/lib/leagues/join";
export { BOARD_LABELS, monthLabel, dayLabel, shiftMonth, isMonth, leaguePeriods } from "../../../src/lib/leagues/settings";
export type { LeaguePeriods, LeagueKind } from "../../../src/lib/leagues/settings";
export type { JoinMode, JoinDecision, JoinRefusal, JoinLeague, JoinApplicant, MembershipStatus } from "../../../src/lib/leagues/join";
export { LEAGUE_VISIBILITIES, LEAGUE_VISIBILITY_BADGE, leagueVisibility, canSeeLeague } from "../../../src/lib/leagues/visibility";
export type { LeagueVisibility, LeagueViewer } from "../../../src/lib/leagues/visibility";
export { orderOfPlay, estimateTimes, aboutTime } from "../../../src/lib/friendly/scheduler";
export type { ScheduledRound, ScheduledMatch, CourtOrder, CourtOrderEntry, MatchEstimate } from "../../../src/lib/friendly/scheduler";
export { buildNightTable, reestimateNight, isNightMatchDone, NIGHT_TABLE_LAYOUT } from "../../../src/lib/friendly/nightTable";
export type { NightTable, NightTableCourt, NightTableEntry, NightTableRound, NightTableMatch, NightEntryState, NightTableLayout } from "../../../src/lib/friendly/nightTable";
export { courtScene, nextAfter, heroCards, isLiveScene, sceneMatchIds, showcaseOn, rulesForMatch, sideIdentity, sidePlayers, sideName, WALKON, RUBBER_WON_MS, TIE_FINAL_MS, RESULT_REST_MS } from "../../../src/lib/tv/showcase";
export type { ShowcaseScene, ShowcaseSceneKind, ShowcaseNext, HeroCard, SideIdentity } from "../../../src/lib/tv/showcase";
export { LIVE_ACTIVITY_NAME, LIVE_ACTIVITY_PHASES, APNS_TOKEN, matchUrl, matchIdFromUrl, liveState, upcomingState, phaseForMatch } from "../../../src/lib/notify/liveActivity";
export type { LiveActivityPhase, LiveScoreState } from "../../../src/lib/notify/liveActivity";
export {
  moneyLabel,
  peoplePerEntry,
  charges,
  STATUS_LABELS as REGISTRATION_STATUS_LABELS,
  REFUND_CUTOFF_MS,
  PAYMENT_FAILED_MESSAGE,
  awaitingPaymentNote,
  onlinePaymentLines,
} from "../../../src/lib/registration/rules";
export { parseCourtLink, courtLink, courtKey } from "../../../src/lib/orgs/courtScope";
export { normalizePin, PIN_LENGTH, callStatusLine, assistanceMessage, isOpenCall, REFEREE_ROLE_LABELS, filterRefereeChoices, type RefereeChoice } from "../../../src/lib/referees/rules";
export type { CallStatus, RefereeRole } from "../../../src/lib/referees/rules";
export { checkLineup, changedRubbers, warningsForChange, needsReason, unaccepted, lineupStep, issueText, exceptionLine, doublesOf, rubberEditable, EMPTY_LINEUP } from "../../../src/lib/tennis/lineupRules";
export type { LineupDraft, LineupIssue, LineupIssueCode, LineupStep, LineupPickerModel, PickerSide, SquadMember } from "../../../src/lib/tennis/lineupRules";
export { ITF_REGULATIONS_URL, ITF_TEAM_REGULATIONS, regulationPath, regulationLabel, regulationSummary } from "../../../src/lib/tennis/regulations";
export type { RegulationSummary } from "../../../src/lib/tennis/regulations";
export * from "../../../src/lib/scoring/serve";
export * from "../../../src/lib/scoring/timing";
export { buildMatchLog, scoreTitle, aceCounts } from "../../../src/lib/scoring/matchLog";
export type { LogEntry, LogEventRow, LogTag } from "../../../src/lib/scoring/matchLog";
export { pushesHistory, LOG_ONLY_EVENTS } from "../../../src/lib/scoring/eventGuard";
export { SCORING_FEATURES_ON, SCORING_FEATURES_OFF } from "../../../src/lib/matchday/rules";
export type { ScoringFeatures } from "../../../src/lib/matchday/rules";
export { ITF_RULES_PDF as ITF_RULES_OF_TENNIS_PDF, rulePath, ruleSummary, ITF_TENNIS_RULES } from "../../../src/lib/tennis/rulesOfTennis";
export { isYouTubeId, parseYouTubeUrl, youtubeWatchUrl, youtubeEmbedUrl, youtubeThumbnailUrl, youtubeErrorKind } from "../../../src/lib/stream/youtube";
export { delayNote } from "../../../src/lib/stream/liveVideo";
export { coachLink, parseCoachLink, COACH_LINK_PATH } from "../../../src/lib/coaches/rules";
// The venue map (migration 0039): the WebView bridge and the map page's URL.
export { parseFromMap, parseToMap, embeddedMapUrl } from "../../../src/lib/venue/bridge";
export type { FromMap, ToMap } from "../../../src/lib/venue/bridge";
export type { PublicVenue, PublicVenueCourt, VenueLive, VenueCourtLive } from "../../../src/lib/venue/types";
// The order of play by day and court (Schedule tab) and the on-screen notices (rain delay, play suspended).
export { TBC_DAY, NO_COURT_TITLE, NO_TIME_TITLE, dayKeyIn, clockIn, itemDay, scheduleDays, defaultScheduleDay, scheduleDayLabel, scheduleForDay } from "../../../src/lib/schedule/orderOfPlay";
export type { ScheduleItem, ScheduleCourt, ScheduleGroup, ScheduleMode, ScheduleStatus, DaySchedule } from "../../../src/lib/schedule/orderOfPlay";
export { PLAY_STATUS_TITLES, noticeBanners, currentMajorAnnouncement, publicPlayStatus, resumeLine } from "../../../src/lib/notices/playStatus";
export type { NoticeBanner, NoticeTone, PlayStatusKind } from "../../../src/lib/notices/playStatus";

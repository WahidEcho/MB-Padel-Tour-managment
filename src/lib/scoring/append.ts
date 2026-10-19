/**
 * Appending score events to a match: the one write path for every scoring
 * device (the events route, src/app/api/matches/[matchId]/events/route.ts) and
 * for the admin's final-result entry (enterFinalResult below).
 *
 * Ordered events (spec §18.8), idempotent on client_event_id; a batch out of
 * sequence, or from a device that does not hold the match, is refused with a 409
 * before anything is written, so conflicts surface instead of corrupting state.
 *
 * RESULT_ENTERED (resultEntry.ts): the state is rebuilt here from the payload with
 * the match's own rules and a client state that differs is refused (400, typed
 * problems). On a partly scored or finished match the result is an audited
 * correction: the events before it are marked superseded, what a finished match
 * awarded is taken back through the same paths an Undo uses (retractKnockout,
 * revertFriendlyResult, the tie and standings recalculation) and the new result
 * is finalised with result_source "correction".
 *
 * Server-only (database). The caller has already checked the staff principal
 * reaches the match (staffRoute / requireTournamentPermission).
 */
import { randomUUID } from "crypto";
import { db } from "../supabase";
import { audit } from "../audit";
import { getMatch, getSnapshot, getTeams, tierForMatch } from "../data";
import { finalizeMatch, upsertSnapshotFromState, type EngineStateLike } from "../ops";
import { claimLease, defaultDeviceLabel, getLease, isLeaseLive, releaseLease } from "../scoringControl";
import { notifyMatchLive } from "../notify/hooks";
import { isDoublesMatch, scoringConfigForMatch } from "./rules";
import type { ScoringModeChoice } from "../matchday/rules";
import { matchScoringMode } from "../referee/bootstrap";
import { sportOf } from "../sports/registry";
import {
  FINISHED_MATCH_STATUSES,
  batchProblem,
  chessDecisionCut,
  correctionCut,
  finishedMatchCut,
  reopensMatch,
  undoAfterResultCut,
  sameState,
  shadowMismatches,
  NON_SCORING_EVENTS,
  LOG_ONLY_EVENTS,
  isV2Event,
  v2Cut,
} from "./eventGuard";
import { matchDayRules } from "../matchday/rules";
import {
  RESULT_ENTERED,
  buildResultState,
  chessCompetitionFor,
  finalResultAllowed,
  parseResultPayload,
  resultProblemMessage,
  type ResultPayload,
  type ResultProblem,
} from "./resultEntry";
import type { ChessCompetition } from "../chess/result";
import type { Match, MatchRules, ResultSource, Role } from "../types";

export interface IncomingEvent {
  client_event_id: string;
  event_number: number;
  event_type: string;
  team_id: string | null;
  previous_state: EngineStateLike | null;
  new_state: EngineStateLike;
  payload: Record<string, unknown> | null;
  created_at_client: string;
}

/** What the route sends back: a status and a JSON body. */
export interface AppendOutcome {
  status: number;
  body: Record<string, unknown>;
}

export interface AppendOptions {
  /** The console role acting (score_match): admin, manager or referee. */
  role: Role | string;
  /** Work after the response (the route's `after`); runs in the background when omitted. */
  defer?: (task: () => Promise<void> | void) => void;
  /** score_events.created_by: "referee:<id>" for a referee signed in with their PIN (migration 0035). */
  createdBy?: string | null;
}

function winnerTeamId(match: Match, state: EngineStateLike): string | null {
  if (state.winner === "A") return match.team_a_id;
  if (state.winner === "B") return match.team_b_id;
  return null;
}

interface OwnerRow {
  sport?: string;
  kind?: string;
  scoring_config?: { requireResultConfirmation?: boolean } & Record<string, unknown>;
  branding_config?: { redBlueTeams?: boolean };
  match_day_rules?: unknown;
  format_config?: { legs?: number } | null;
}

async function ownerOf(match: Match): Promise<OwnerRow | null> {
  const { data } = await db()
    .from("tournaments")
    .select("sport, kind, scoring_config, branding_config, match_day_rules, format_config")
    .eq("id", match.tournament_id)
    .maybeSingle();
  return (data as OwnerRow | null) ?? null;
}

/** Everything a result is rebuilt with: the sport's engine, the match's resolved rules and how it is recorded. */
export interface ResultContext {
  engine: "games" | "chess";
  rules: MatchRules;
  mode: ScoringModeChoice;
  competition: ChessCompetition;
  legs: 1 | 2;
}

export async function resultContext(match: Match, owner: OwnerRow | null): Promise<ResultContext> {
  const sport = sportOf(owner ?? undefined);
  const mode = await matchScoringMode(match, owner ?? {});
  let rules: MatchRules = sport.defaultRules;
  if (sport.engine !== "chess") {
    const [teams, tier] = await Promise.all([getTeams(match.tournament_id), tierForMatch(match)]);
    const a = teams.find((t) => t.id === match.team_a_id);
    const b = teams.find((t) => t.id === match.team_b_id);
    rules = scoringConfigForMatch(owner as never, match, tier, {
      doubles: match.rubber_type ? match.rubber_type === "D" : isDoublesMatch(a, b),
    });
  }
  return {
    engine: sport.engine,
    rules,
    mode,
    competition: chessCompetitionFor(match.stage),
    legs: owner?.format_config?.legs === 2 ? 2 : 1,
  };
}

export type ResultCheck = { ok: true; state: EngineStateLike; winnerTeamId: string | null } | { ok: false; problems: ResultProblem[] };

/**
 * The state a RESULT_ENTERED comes to, rebuilt on the server, or why it cannot
 * be recorded. `clientState` (when given) must be that state exactly.
 */
export async function checkResult(
  match: Match,
  ctx: ResultContext,
  rawPayload: unknown,
  opts: { role: string; clientState?: unknown; teamId?: string | null; winnerTeamId?: unknown },
): Promise<ResultCheck> {
  const problem = (code: ResultProblem["code"], message: string): ResultCheck => ({ ok: false, problems: [{ code, set: null, message }] });
  if (!match.team_a_id || !match.team_b_id) return problem("not_playable", "Both sides must be known before a result is entered.");
  if (match.status === "cancelled") return problem("not_playable", "This match was cancelled.");
  if (!finalResultAllowed(ctx.mode)) {
    return problem("mode", "This match is scored point by point: the organiser can allow final results on the Match day tab.");
  }
  const parsed = parseResultPayload(rawPayload, ctx.engine);
  if (!parsed.ok) return parsed;
  const payload: ResultPayload = parsed.payload;
  const built = buildResultState({ engine: ctx.engine, rules: ctx.rules, payload, competition: ctx.competition, legs: ctx.legs });
  if (!built.ok) return built;

  let state = built.state as unknown as EngineStateLike;
  if (built.engine === "chess" && built.level && built.advance) {
    // The organiser's decision, exactly as the referee console's arbiter card records it.
    if (opts.role !== "admin" && opts.role !== "manager") {
      return problem("advance_not_allowed", "The pairing is level: the organiser decides who advances.");
    }
    const { decideWinner } = await import("../chess/engine");
    state = decideWinner(built.state as never, built.advance) as unknown as EngineStateLike;
  }
  const winner = winnerTeamId(match, state);
  if (opts.teamId != null && opts.teamId !== winner) return problem("winner_mismatch", "The result names the wrong winner.");
  if (opts.winnerTeamId != null && opts.winnerTeamId !== winner) return problem("winner_mismatch", "The result names the wrong winner.");
  if (opts.clientState !== undefined && !sameState(opts.clientState, state)) {
    return problem("state_mismatch", "The score on this device does not match the result entered. Enter it again.");
  }
  return { ok: true, state, winnerTeamId: winner };
}

/** A refused result, in the shape every client reads. */
function resultRefusal(event: { client_event_id: string } | null, problems: ResultProblem[]): AppendOutcome {
  return {
    status: 400,
    body: { error: resultProblemMessage(problems), code: "final_score", problems, event: event?.client_event_id ?? null, applied: [] },
  };
}

export async function appendScoreEvents(match: Match, deviceId: string, events: IncomingEvent[], opts: AppendOptions): Promise<AppendOutcome> {
  const role = opts.role;
  const defer = opts.defer ?? ((task: () => Promise<void> | void) => void Promise.resolve().then(task).catch((err) => console.error(err)));
  const matchId = match.id;
  if (!deviceId || typeof deviceId !== "string" || !Array.isArray(events) || events.length === 0) {
    return { status: 400, body: { error: "deviceId and events required" } };
  }
  // Refuse what no honest client sends before anything is written: unknown event
  // types, or a team or winner that is not one of this match's two sides.
  const problem = batchProblem(events, match);
  if (problem) return { status: problem.status, body: { error: problem.error } };

  // Read once per request. Only `true` turns confirmation on, so a tournament
  // that has never set it keeps finishing on the final point as before. Chess has
  // no confirm step on its board, so the flag never applies to it — otherwise a
  // chess match would sit finished-but-live forever.
  const ownerRow = await ownerOf(match);
  const requiresConfirmation = ownerRow?.sport !== "chess" && ownerRow?.scoring_config?.requireResultConfirmation === true;

  const { data: existingRows } = await db()
    .from("score_events")
    .select("client_event_id")
    .eq("match_id", matchId)
    .in("client_event_id", events.map((e) => e.client_event_id));
  const existing = new Set((existingRows ?? []).map((r) => r.client_event_id));

  // Final results are rebuilt here before anything is written (and before the
  // lease is touched); the stored state is the server's own.
  let correctingResult = false;
  const freshResults = events.filter((e) => e.event_type === RESULT_ENTERED && !existing.has(e.client_event_id));
  if (freshResults.length > 0) {
    const ctx = await resultContext(match, ownerRow);
    for (const e of freshResults) {
      const checked = await checkResult(match, ctx, e.payload, {
        role: String(role),
        clientState: e.new_state,
        teamId: e.team_id,
        winnerTeamId: e.payload?.winner_team_id,
      });
      if (!checked.ok) return resultRefusal(e, checked.problems);
      e.new_state = checked.state;
    }
    correctingResult = true;
  }

  // Who may record what, decided before the lease is touched (a refused batch must not
  // take the match from the device holding it, nor claim a finished match). A result
  // over a match that already has a score is a correction, the organiser's staff only
  // (a referee code must not overwrite a recorded result); in chess, who advances from
  // a level pairing is the organiser's too.
  const roleCuts: { cut: ReturnType<typeof correctionCut>; conflict: string }[] = [];
  {
    const batch = events.filter((e) => !existing.has(e.client_event_id)).sort((a, b) => a.event_number - b.event_number);
    let scoredBefore = (FINISHED_MATCH_STATUSES as readonly string[]).includes(match.status);
    if (!scoredBefore && batch.some((e) => e.event_type === RESULT_ENTERED)) {
      const { data: prior } = await db().from("score_events").select("event_type").eq("match_id", matchId).limit(5000);
      scoredBefore = ((prior ?? []) as { event_type: string }[]).some((r) => !NON_SCORING_EVENTS.has(r.event_type));
    }
    roleCuts.push(
      { cut: correctionCut(String(role), scoredBefore, batch), conflict: "organiser_only" },
      { cut: sportOf(ownerRow ?? undefined).engine === "chess" ? chessDecisionCut(String(role), batch) : null, conflict: "organiser_only" },
    );
    // Scoring v2 (faults, aces, lets, serve order, timers): the tournament must have the
    // feature on, and each event's state must be what the shared engine gives. The
    // server re-derives it rather than trusting the device.
    if (batch.some((e) => isV2Event(e))) {
      const ctx = sportOf(ownerRow ?? undefined).engine === "games" ? await resultContext(match, ownerRow) : null;
      const features = matchDayRules(ownerRow?.match_day_rules, ownerRow ?? undefined).features;
      const cut = v2Cut(batch, { teamA: match.team_a_id, config: ctx ? (ctx.rules as never) : null, features });
      if (cut) roleCuts.push({ cut, conflict: cut.code });
    }
    const early = roleCuts.map((c) => c.cut).find((c) => c?.index === 0);
    if (early) {
      const conflict = roleCuts.find((c) => c.cut === early)?.conflict ?? "organiser_only";
      return { status: 409, body: { error: early.error, conflict, applied: [], event: batch[0]?.client_event_id ?? null } };
    }
  }

  // Same shape as before, translated to a lease: refuse a live lease held by
  // someone else, and silently claim an unheld (or stale) one for whichever
  // device's events are landing — an offline-first sync can arrive before its
  // own /claim request ever resolves, and it still needs to end up holding
  // the match. A lease this device already holds is left untouched: the
  // periodic renew-lease heartbeat is what extends it, not every sync.
  const existingLease = await getLease(matchId);
  const leaseNowMs = Date.now();
  if (existingLease && isLeaseLive(existingLease, leaseNowMs) && existingLease.device_id !== deviceId) {
    return { status: 409, body: { error: "Another device controls this match", conflict: "device_lock" } };
  }
  if (!existingLease || !isLeaseLive(existingLease, leaseNowMs)) {
    const claimed = await claimLease(matchId, match.tournament_id, deviceId, defaultDeviceLabel(deviceId));
    if (!claimed.ok) {
      // Lost the race for the same just-freed lease to another device's claim.
      return { status: 409, body: { error: "Another device controls this match", conflict: "device_lock" } };
    }
  }

  let snapshot = await getSnapshot(matchId);
  // The snapshot is written after the events, not with them, so a request that
  // failed between the two left it behind the event log; every retry then hit a
  // sequence conflict forever. The log is the truth: when it is ahead, the
  // snapshot is brought level from the last stored event before anything else.
  const { data: lastRow } = await db()
    .from("score_events")
    .select("event_number, event_type, team_id, new_state_json")
    .eq("match_id", matchId)
    .order("event_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  const logged = lastRow as { event_number: number; event_type: string; team_id: string | null; new_state_json: EngineStateLike } | null;
  if (logged && logged.event_number > (snapshot?.last_event_number ?? 0) && logged.new_state_json) {
    await upsertSnapshotFromState(match, logged.new_state_json, logged.event_number, {
      lastEventType: logged.event_type,
      lastEventTeamId: logged.team_id,
      lastUndoEventNumber: snapshot?.last_undo_event_number ?? 0,
    });
    snapshot = await getSnapshot(matchId);
  }
  let lastApplied = Math.max(snapshot?.last_event_number ?? 0, logged?.event_number ?? 0);
  // Carried into the snapshot so the venue screen can tell a scored point from a
  // correction. Events are append-only, so an UNDO has a higher number than the
  // point it cancels — without this watermark nothing downstream can see it.
  let lastUndo = snapshot?.last_undo_event_number ?? 0;
  let lastEventType: string | null = null;
  let lastEventTeamId: string | null = null;

  const snapshotBefore = snapshot?.snapshot_json ?? null;
  const fresh = events.filter((e) => !existing.has(e.client_event_id)).sort((a, b) => a.event_number - b.event_number);
  // Sequence and reopen checks run before the first insert, so a refused batch
  // leaves nothing behind. (They used to run inside the loop, after earlier
  // events of the same batch were already stored, which stalled the phone.)
  {
    let expect = lastApplied + 1;
    for (const e of fresh) {
      if (e.event_number !== expect) {
        return {
          status: 409,
          body: { error: `Event sequence mismatch: expected ${expect}, got ${e.event_number}`, conflict: "sequence", applied: [] },
        };
      }
      expect++;
    }
  }
  // A finished match takes nothing but an UNDO that reopens it, or a final result
  // that corrects it: a second MATCH_ENDED or a WALKOVER after the win must not
  // rewrite the result. The events before the first refused one are a valid run
  // (the batch that finished the match, say) and are kept; the refusal is
  // reported after them.
  const finishedNow = (FINISHED_MATCH_STATUSES as readonly string[]).includes(match.status);
  // An UNDO after a final result is refused the same way: a result is changed
  // only by a new result (an audited correction), never stepped back.
  let resultStored = false;
  if (fresh.some((e) => e.event_type === "UNDO")) {
    const { data: results } = await db()
      .from("score_events")
      .select("event_number")
      .eq("match_id", matchId)
      .eq("event_type", RESULT_ENTERED)
      .eq("sync_status", "synced")
      .limit(1);
    resultStored = (results ?? []).length > 0;
  }
  const cuts = [
    { cut: finishedMatchCut(match.status, fresh, requiresConfirmation), conflict: "finished" },
    { cut: undoAfterResultCut(resultStored, fresh), conflict: "result_entered" },
    ...roleCuts,
  ].filter((c): c is { cut: NonNullable<typeof c.cut>; conflict: string } => c.cut !== null);
  const first = cuts.sort((a, b) => a.cut.index - b.cut.index)[0] ?? null;
  const cut = first?.cut ?? null;
  const cutConflict = first?.conflict ?? "finished";
  if (cut && cut.index === 0) {
    return { status: 409, body: { error: cut.error, conflict: cutConflict, applied: [], event: fresh[0]?.client_event_id ?? null } };
  }
  if (cut) fresh.splice(cut.index);
  const reopens = finishedNow && fresh.some((e) => reopensMatch(e, requiresConfirmation));
  // A result entered over a finished match takes back what the old result
  // awarded first, exactly as an Undo past the end does.
  const corrects = finishedNow && correctingResult && fresh.some((e) => e.event_type === RESULT_ENTERED);
  if (reopens || corrects) {
    if (match.tie_id) {
      const { canReopenRubber } = await import("../tennis/tieOps");
      const check = await canReopenRubber(match);
      if (!check.ok) {
        return { status: 409, body: { error: check.message, conflict: check.reason, applied: [] } };
      }
    } else if (match.stage !== "group") {
      // A session's matches carry stage 'friendly' whatever their round: a session
      // drawn as a knockout still has bracket slots, and its later round is checked
      // and taken back like a tournament's (a no-op without slots).
      const { retractKnockout } = await import("../ops");
      if (match.stage === "friendly") {
        // Mexicano pairs each round from the standings after the last one: once the
        // next round is drawn, an earlier result is part of it and cannot change.
        const { laterMexicanoRound } = await import("../friendly/ops");
        if (await laterMexicanoRound(match.id)) {
          return {
            status: 409,
            body: {
              error: "The next Mexicano round was drawn from this result, so it cannot be changed. Correct it only before the next round is drawn.",
              conflict: "next_round_drawn",
              applied: [],
            },
          };
        }
      }
      const retraction = await retractKnockout(match);
      if (!retraction.ok) {
        return {
          status: 409,
          body: {
            error: "The next round has already started, so this result cannot be changed. Correct the later match first.",
            conflict: retraction.reason,
            applied: [],
          },
        };
      }
    }
  }

  const applied: string[] = [];
  let finalState: EngineStateLike | null = null;
  let statusUpdate: Record<string, unknown> = {};
  let startedNow = false;
  let finalize: { status: "completed" | "walkover" | "disqualified" | "retired"; winner: string; source: ResultSource } | null = null;
  let entered: { event: IncomingEvent; correction: boolean } | null = null;

  for (const e of fresh) {
    const { error } = await db().from("score_events").insert({
      client_event_id: e.client_event_id,
      tournament_id: match.tournament_id,
      match_id: matchId,
      event_number: e.event_number,
      event_type: e.event_type,
      team_id: e.team_id,
      previous_state_json: e.previous_state,
      new_state_json: e.new_state,
      created_by_role: role,
      created_by: opts.createdBy ?? null,
      created_at_client: e.created_at_client,
      sync_status: "synced",
      note: e.payload ? JSON.stringify(e.payload) : null,
    });
    if (error) {
      return { status: 500, body: { error: error.message, applied } };
    }
    const priorEvents = lastApplied > 0;
    lastApplied = e.event_number;
    applied.push(e.client_event_id);
    finalState = e.new_state;
    lastEventType = e.event_type;
    lastEventTeamId = e.team_id ?? null;
    if (e.event_type === "UNDO") lastUndo = e.event_number;

    switch (e.event_type) {
      case "MATCH_STARTED":
        startedNow = true;
        statusUpdate = {
          ...statusUpdate,
          status: "live",
          started_at: match.started_at ?? new Date().toISOString(),
          serving_team_id:
            e.new_state.servingTeam === "A" ? match.team_a_id : e.new_state.servingTeam === "B" ? match.team_b_id : null,
        };
        break;
      case "MATCH_PAUSED":
        statusUpdate = { ...statusUpdate, status: "paused" };
        break;
      case "MATCH_RESUMED":
        statusUpdate = { ...statusUpdate, status: "live" };
        break;
      case "SERVER_CHANGED":
        statusUpdate = {
          ...statusUpdate,
          // Null in a tie-break, where the serve rotates by point: never team B by default.
          serving_team_id:
            e.new_state.servingTeam === "A" ? match.team_a_id : e.new_state.servingTeam === "B" ? match.team_b_id : null,
        };
        break;
      case "FORCE_END":
      case "MATCH_ENDED":
        finalize = {
          status: "completed",
          winner: (e.payload?.winner_team_id as string) ?? winnerTeamId(match, e.new_state) ?? "",
          source: "point_by_point",
        };
        break;
      case "WALKOVER":
        finalize = { status: "walkover", winner: (e.payload?.winner_team_id as string) ?? "", source: "point_by_point" };
        break;
      case "DISQUALIFICATION":
        finalize = { status: "disqualified", winner: (e.payload?.winner_team_id as string) ?? "", source: "point_by_point" };
        break;
      case "RETIREMENT":
        finalize = { status: "retired", winner: (e.payload?.winner_team_id as string) ?? "", source: "point_by_point" };
        break;
      case RESULT_ENTERED: {
        // Everything before the result is superseded by it (kept, for the record).
        if (priorEvents) {
          await db().from("score_events").update({ sync_status: "superseded" }).eq("match_id", matchId).lt("event_number", e.event_number);
        }
        entered = { event: e, correction: priorEvents };
        const winner = winnerTeamId(match, e.new_state);
        if (e.new_state.matchOver && winner) {
          finalize = { status: "completed", winner, source: priorEvents ? "correction" : "final_score" };
          if (!match.started_at) statusUpdate = { ...statusUpdate, started_at: new Date().toISOString() };
        } else {
          // A level chess knockout: recorded, live, waiting for the organiser.
          finalize = null;
          statusUpdate = {
            ...statusUpdate,
            status: "live",
            started_at: match.started_at ?? new Date().toISOString(),
            ...(finishedNow ? { winner_team_id: null, ended_at: null, result_source: null } : {}),
          };
        }
        break;
      }
    }
    // A point that ends the match naturally also completes it — unless the
    // tournament asks the referee to confirm. Then the snapshot records the final
    // score (so every screen shows it at once) but the match waits for an
    // explicit MATCH_ENDED. Explicit end events above always finalise.
    if (!finalize && e.event_type !== RESULT_ENTERED && e.new_state.matchOver && e.new_state.winner && !requiresConfirmation) {
      finalize = { status: "completed", winner: winnerTeamId(match, e.new_state) ?? "", source: "point_by_point" };
    }
    // Undo past the end reopens the match (spec §4.5 "Match reopened"), and so
    // does undoing a confirmation when results need confirming.
    if (reopensMatch(e, requiresConfirmation)) {
      finalize = null;
      if (finishedNow) {
        // The knockout or tie checks for this reopen already ran before any insert.
        statusUpdate = { ...statusUpdate, status: "live", winner_team_id: null, ended_at: null, result_source: null };
      }
    }
  }

  if (finalState) {
    await upsertSnapshotFromState(match, finalState, lastApplied, {
      lastEventType,
      lastEventTeamId,
      lastUndoEventNumber: lastUndo,
    });
  }
  // A correction of a finished friendly match: its ledger rows go first, so the
  // new result's points replace the old ones instead of sitting beside them.
  if (corrects && match.stage === "friendly" && finalize) {
    const { revertFriendlyResult } = await import("../friendly/ops");
    await revertFriendlyResult(matchId, String(role));
  }
  if (finalize && entered && statusUpdate.started_at) {
    // A result entered on a match nobody started on a device still gets a start time.
    await db().from("matches").update({ started_at: statusUpdate.started_at }).eq("id", matchId);
  }
  if (Object.keys(statusUpdate).length > 0 && !finalize) {
    await db()
      .from("matches")
      .update({ ...statusUpdate, updated_at: new Date().toISOString() })
      .eq("id", matchId);
    // Reopening a finished match un-does whatever it awarded.
    if ("winner_team_id" in statusUpdate) {
      if (match.tie_id) {
        const { applyTieResult } = await import("../tennis/tieOps");
        await applyTieResult(match.tie_id);
      } else if (match.stage === "group") {
        const { recalcStandings } = await import("../ops");
        await recalcStandings(match.tournament_id);
      } else if (match.stage === "friendly") {
        // Its ledger rows must go, or players keep points for a match that is
        // no longer finished — and every affected player's fire streak has to
        // be replayed, since removing a result changes the whole sequence.
        const { revertFriendlyResult } = await import("../friendly/ops");
        await revertFriendlyResult(matchId, "referee");
      }
      // League points a tournament match gave (a session's go through
      // revertFriendlyResult above).
      if (match.stage !== "friendly") {
        const { onMatchReopened } = await import("../results/hooks");
        await onMatchReopened(match);
      }
    }
  }
  // A retry whose events were all stored already carries nothing fresh, so a
  // finalise that failed the first time was never attempted again and the match
  // stayed live with a finished score. Reconcile from the stored state instead.
  if (!finalize && fresh.length === 0 && !requiresConfirmation && ["live", "paused", "pending_sync"].includes(match.status)) {
    const stored = (snapshot?.snapshot_json ?? null) as EngineStateLike | null;
    if (stored?.matchOver && stored.winner) {
      const source: ResultSource = logged?.event_type === RESULT_ENTERED ? (logged.event_number > 1 ? "correction" : "final_score") : "point_by_point";
      finalize = { status: "completed", winner: winnerTeamId(match, stored) ?? "", source };
    }
  }
  if (entered) {
    // Who recorded what, and what it replaced. finalizeMatch adds its own row.
    await audit({
      tournament_id: match.tournament_id,
      actor_role: String(role),
      action: entered.correction ? "RESULT_CORRECTED" : "RESULT_ENTERED",
      entity_type: "match",
      entity_id: matchId,
      old_value: entered.correction
        ? {
            status: match.status,
            winner_team_id: match.winner_team_id,
            result_source: match.result_source ?? null,
            sets: (snapshotBefore as { completedSets?: unknown } | null)?.completedSets ?? null,
            superseded_through_event: entered.event.event_number - 1,
          }
        : null,
      new_value: {
        payload: entered.event.payload,
        winner_team_id: winnerTeamId(match, entered.event.new_state),
        event_number: entered.event.event_number,
        device_id: deviceId,
      },
    });
  }
  if (finalize && finalize.winner) {
    await finalizeMatch(match, {
      status: finalize.status,
      winnerTeamId: finalize.winner,
      actorRole: String(role ?? "referee"),
      resultSource: finalize.source,
      // A corrected result of a match that had already finished: "match finished"
      // went out the first time, and there is no "result corrected" alert.
      notifyFinished: !corrects,
    });
  }
  // Match day: the call to court is over once the match starts or is decided.
  if (startedNow || (finalize && finalize.winner)) {
    const { closeCall } = await import("../matchday/server");
    await closeCall(matchId, finalize?.status === "walkover" ? "walkover" : "started");
  }
  if (startedNow && !finalize) {
    defer(() => notifyMatchLive(match));
    // A night's table: a match that went on late (or early) moves its court's next ones.
    if (match.stage === "friendly") {
      defer(async () => {
        const { onNightProgress } = await import("../results/hooks");
        await onNightProgress(match.tournament_id);
      });
    }
  }

  // Match day: one game from the end tells the next match on the court (once per match).
  if (fresh.length > 0 && finalState && !finalize && sportOf(ownerRow ?? undefined).supports.nearEnd) {
    const before = snapshotBefore;
    const after = finalState;
    defer(async () => {
      try {
        const { onScoreProgress } = await import("../matchday/server");
        await onScoreProgress({ match, before, after });
      } catch (err) {
        console.error("match soon check failed", err);
      }
    });
  }

  // iPhone lock-screen scores following this match.
  if (fresh.length > 0) {
    const ended = Boolean(finalize?.winner);
    defer(async () => {
      try {
        const { getConfig } = await import("../mobile/server");
        if (!(await getConfig()).flags.live_activity) return;
        const [{ pushLiveActivities, liveState }, { toScore }] = await Promise.all([import("../notify/apns"), import("../mobile/projection")]);
        const latest = await getSnapshot(matchId);
        const [{ data: names }, { data: courtRow }] = await Promise.all([
          db().from("teams").select("id, team_name, nation_code").in("id", [match.team_a_id, match.team_b_id].filter(Boolean) as string[]),
          match.court_id ? db().from("courts").select("court_name").eq("id", match.court_id).maybeSingle() : Promise.resolve({ data: null }),
        ]);
        const court = (courtRow as { court_name?: string } | null)?.court_name ?? "";
        const label = (id: string | null) => {
          const t = ((names ?? []) as { id: string; team_name: string; nation_code: string | null }[]).find((x) => x.id === id);
          return t?.nation_code ?? t?.team_name ?? "";
        };
        const gameChanged =
          fresh.some((e) => e.event_type !== "POINT_AWARDED" && !LOG_ONLY_EVENTS.has(e.event_type) && e.event_type !== "FAULT" && e.event_type !== "LET") || (finalState?.teamA?.points === "0" && finalState?.teamB?.points === "0");
        await pushLiveActivities(
          matchId,
          liveState(toScore(match, latest), { a: label(match.team_a_id), b: label(match.team_b_id), court, status: ended ? "Final" : "Live" }),
          { end: ended, important: gameChanged },
        );
      } catch (err) {
        console.error("live activity push failed", err);
      }
    });
  }

  // Shadow check: re-derive each point with the shared engine and log any
  // disagreement. Never rejects; it runs after the response is sent.
  if (fresh.length > 0) {
    const priorState = snapshotBefore;
    defer(async () => {
      try {
        let config = null;
        if (ownerRow?.sport !== "chess") {
          const [teams, tier] = await Promise.all([getTeams(match.tournament_id), tierForMatch(match)]);
          const a = teams.find((x) => x.id === match.team_a_id);
          const b = teams.find((x) => x.id === match.team_b_id);
          config = scoringConfigForMatch(ownerRow as never, match, tier, {
            doubles: match.rubber_type ? match.rubber_type === "D" : isDoublesMatch(a, b),
          });
        }
        const issues = shadowMismatches(fresh, { snapshotState: priorState, teamA: match.team_a_id, config });
        if (issues.length) {
          await audit({
            tournament_id: match.tournament_id,
            actor_role: String(role),
            action: "SCORE_SHADOW_MISMATCH",
            entity_type: "match",
            entity_id: match.id,
            new_value: { deviceId, issues: issues.slice(0, 20) },
          });
        }
      } catch (err) {
        console.error("shadow check failed", err);
      }
    });
  }

  if (cut) {
    return { status: 409, body: { error: cut.error, conflict: cutConflict, applied, last_event_number: lastApplied } };
  }

  return {
    status: 200,
    body: {
      ok: true,
      applied,
      last_event_number: lastApplied,
      // The organiser can switch red and blue teams during a match. The scoring page
      // never reloads, so each sync tells it the current setting: the walls and the
      // voice switch together, from the next point.
      red_blue_teams: ownerRow?.branding_config?.redBlueTeams === true,
    },
  };
}

/* ---------------- the admin's final-result entry ---------------- */

export type EnterResultOutcome =
  | { ok: true; status: string; winnerTeamId: string | null; correction: boolean }
  | { ok: false; error: string; problems?: ResultProblem[]; conflict?: string };

/**
 * Records a final result typed on the admin matches page (admin or manager) as a
 * RESULT_ENTERED event through the same path as a scoring device. The organiser
 * may also pick who advances from a level chess knockout (`advance`).
 *
 * The caller checks the principal reaches the match first.
 */
export async function enterFinalResult(input: {
  matchId: string;
  payload: unknown;
  role: Role | string;
  actor: string;
  defer?: AppendOptions["defer"];
}): Promise<EnterResultOutcome> {
  const match = await getMatch(input.matchId);
  if (!match) return { ok: false, error: "Match not found" };
  const owner = await ownerOf(match);
  const ctx = await resultContext(match, owner);
  const checked = await checkResult(match, ctx, input.payload, { role: String(input.role) });
  if (!checked.ok) return { ok: false, error: resultProblemMessage(checked.problems), problems: checked.problems };

  const [snapshot, { data: lastRow }] = await Promise.all([
    getSnapshot(match.id),
    db().from("score_events").select("event_number, new_state_json").eq("match_id", match.id).order("event_number", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const logged = lastRow as { event_number: number; new_state_json: EngineStateLike | null } | null;
  const last = Math.max(snapshot?.last_event_number ?? 0, logged?.event_number ?? 0);
  const previous = (logged && logged.event_number >= (snapshot?.last_event_number ?? 0) ? logged.new_state_json : snapshot?.snapshot_json) ?? null;
  // One device id per staff member, so a second admin tab is the same device.
  const deviceId = `admin-${input.actor}`.replace(/[^0-9a-zA-Z-]/g, "-").slice(0, 64);
  const event: IncomingEvent = {
    client_event_id: randomUUID(),
    event_number: last + 1,
    event_type: RESULT_ENTERED,
    team_id: checked.winnerTeamId,
    previous_state: previous as EngineStateLike | null,
    new_state: checked.state,
    payload: input.payload as Record<string, unknown>,
    created_at_client: new Date().toISOString(),
  };
  const out = await appendScoreEvents(match, deviceId, [event], { role: input.role, defer: input.defer });
  if (out.status !== 200) {
    const body = out.body as { error?: string; problems?: ResultProblem[]; conflict?: string };
    const error =
      body.conflict === "device_lock"
        ? "A scoring device holds this match. Unlock it first (or let the referee finish), then enter the result."
        : body.conflict === "sequence"
          ? "The score changed while you were typing. Reload and enter the result again."
          : (body.error ?? "The result was not recorded.");
    return { ok: false, error, problems: body.problems, conflict: body.conflict };
  }
  const after = await getMatch(match.id);
  // A level chess knockout stays live for the organiser's decision: do not keep
  // the match locked to this admin page.
  if (after && !(FINISHED_MATCH_STATUSES as readonly string[]).includes(after.status)) {
    await releaseLease(match.id, deviceId);
  }
  return { ok: true, status: after?.status ?? match.status, winnerTeamId: after?.winner_team_id ?? null, correction: last > 0 };
}

import { NextResponse, after } from "next/server";
import { db } from "@/lib/supabase";
import { currentRole, can } from "@/lib/auth";
import { getMatch, getSnapshot } from "@/lib/data";
import { finalizeMatch, upsertSnapshotFromState, type EngineStateLike } from "@/lib/ops";
import { claimLease, defaultDeviceLabel, getLease, isLeaseLive } from "@/lib/scoringControl";
import type { Match } from "@/lib/types";
import { batchProblem, shadowMismatches } from "@/lib/scoring/eventGuard";
import { notifyMatchLive } from "@/lib/notify/hooks";

interface IncomingEvent {
  client_event_id: string;
  event_number: number;
  event_type: string;
  team_id: string | null;
  previous_state: EngineStateLike | null;
  new_state: EngineStateLike;
  payload: Record<string, unknown> | null;
  created_at_client: string;
}

function winnerTeamId(match: Match, state: EngineStateLike): string | null {
  if (state.winner === "A") return match.team_a_id;
  if (state.winner === "B") return match.team_b_id;
  return null;
}

/**
 * Ordered event sync from the active scoring device (spec §18.8).
 * Idempotent on client_event_id; rejects out-of-sequence batches and
 * non-controlling devices so conflicts surface instead of corrupting state.
 */
export async function POST(request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const role = await currentRole();
  if (!can(role, "score_match")) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }
  const { matchId } = await params;
  const body = await request.json();
  const deviceId: string = body.deviceId;
  const events: IncomingEvent[] = body.events ?? [];
  if (!deviceId || typeof deviceId !== "string" || !Array.isArray(events) || events.length === 0) {
    return NextResponse.json({ error: "deviceId and events required" }, { status: 400 });
  }

  const match = await getMatch(matchId);
  if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 });
  // Refuse what no honest client sends before anything is written: unknown event
  // types, or a team or winner that is not one of this match's two sides.
  const problem = batchProblem(events, match);
  if (problem) return NextResponse.json({ error: problem.error }, { status: problem.status });
  // Same shape as before, translated to a lease: refuse a live lease held by
  // someone else, and silently claim an unheld (or stale) one for whichever
  // device's events are landing — an offline-first sync can arrive before its
  // own /claim request ever resolves, and it still needs to end up holding
  // the match. A lease this device already holds is left untouched: the
  // periodic renew-lease heartbeat is what extends it, not every sync.
  const existingLease = await getLease(matchId);
  const leaseNowMs = Date.now();
  if (existingLease && isLeaseLive(existingLease, leaseNowMs) && existingLease.device_id !== deviceId) {
    return NextResponse.json(
      { error: "Another device controls this match", conflict: "device_lock" },
      { status: 409 }
    );
  }
  if (!existingLease || !isLeaseLive(existingLease, leaseNowMs)) {
    const claimed = await claimLease(matchId, match.tournament_id, deviceId, defaultDeviceLabel(deviceId));
    if (!claimed.ok) {
      // Lost the race for the same just-freed lease to another device's claim.
      return NextResponse.json(
        { error: "Another device controls this match", conflict: "device_lock" },
        { status: 409 }
      );
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
  // Read once per request. Only `true` turns confirmation on, so a tournament
  // that has never set it keeps finishing on the final point as before. Chess has
  // no confirm step on its board, so the flag never applies to it — otherwise a
  // chess match would sit finished-but-live forever.
  const { data: owner } = await db()
    .from("tournaments")
    .select("sport, scoring_config, branding_config")
    .eq("id", match.tournament_id)
    .maybeSingle();
  const ownerRow = owner as {
    sport?: string;
    scoring_config?: { requireResultConfirmation?: boolean };
    branding_config?: { redBlueTeams?: boolean };
  } | null;
  const requiresConfirmation =
    ownerRow?.sport !== "chess" && ownerRow?.scoring_config?.requireResultConfirmation === true;
  // Carried into the snapshot so the venue screen can tell a scored point from a
  // correction. Events are append-only, so an UNDO has a higher number than the
  // point it cancels — without this watermark nothing downstream can see it.
  let lastUndo = snapshot?.last_undo_event_number ?? 0;
  let lastEventType: string | null = null;
  let lastEventTeamId: string | null = null;

  const { data: existingRows } = await db()
    .from("score_events")
    .select("client_event_id")
    .eq("match_id", matchId)
    .in("client_event_id", events.map((e) => e.client_event_id));
  const existing = new Set((existingRows ?? []).map((r) => r.client_event_id));

  const snapshotBefore = snapshot?.snapshot_json ?? null;
  const fresh = events
    .filter((e) => !existing.has(e.client_event_id))
    .sort((a, b) => a.event_number - b.event_number);
  // Sequence and reopen checks run before the first insert, so a refused batch
  // leaves nothing behind. (They used to run inside the loop, after earlier
  // events of the same batch were already stored, which stalled the phone.)
  {
    let expect = lastApplied + 1;
    for (const e of fresh) {
      if (e.event_number !== expect) {
        return NextResponse.json(
          { error: `Event sequence mismatch: expected ${expect}, got ${e.event_number}`, conflict: "sequence", applied: [] },
          { status: 409 },
        );
      }
      expect++;
    }
  }
  const finishedNow = ["completed", "walkover", "disqualified", "retired"].includes(match.status);
  const reopens = finishedNow && fresh.some((e) => e.event_type === "UNDO" && !e.new_state.matchOver);
  if (reopens) {
    if (match.tie_id) {
      const { canReopenRubber } = await import("@/lib/tennis/tieOps");
      const check = await canReopenRubber(match);
      if (!check.ok) {
        return NextResponse.json({ error: check.message, conflict: check.reason, applied: [] }, { status: 409 });
      }
    } else if (match.stage !== "group" && match.stage !== "friendly") {
      const { retractKnockout } = await import("@/lib/ops");
      const retraction = await retractKnockout(match);
      if (!retraction.ok) {
        return NextResponse.json(
          {
            error: "The next round has already started, so this result cannot be undone. Correct the later match first.",
            conflict: retraction.reason,
            applied: [],
          },
          { status: 409 },
        );
      }
    }
  }

  const applied: string[] = [];
  let finalState: EngineStateLike | null = null;
  let statusUpdate: Record<string, unknown> = {};
  let startedNow = false;
  let finalize: { status: "completed" | "walkover" | "disqualified" | "retired"; winner: string } | null = null;

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
      created_at_client: e.created_at_client,
      sync_status: "synced",
      note: e.payload ? JSON.stringify(e.payload) : null,
    });
    if (error) {
      return NextResponse.json({ error: error.message, applied }, { status: 500 });
    }
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
            e.new_state.servingTeam === "A"
              ? match.team_a_id
              : e.new_state.servingTeam === "B"
                ? match.team_b_id
                : null,
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
            e.new_state.servingTeam === "A"
              ? match.team_a_id
              : e.new_state.servingTeam === "B"
                ? match.team_b_id
                : null,
        };
        break;
      case "FORCE_END":
      case "MATCH_ENDED":
        finalize = {
          status: "completed",
          winner: (e.payload?.winner_team_id as string) ?? winnerTeamId(match, e.new_state) ?? "",
        };
        break;
      case "WALKOVER":
        finalize = { status: "walkover", winner: (e.payload?.winner_team_id as string) ?? "" };
        break;
      case "DISQUALIFICATION":
        finalize = { status: "disqualified", winner: (e.payload?.winner_team_id as string) ?? "" };
        break;
      case "RETIREMENT":
        finalize = { status: "retired", winner: (e.payload?.winner_team_id as string) ?? "" };
        break;
    }
    // A point that ends the match naturally also completes it — unless the
    // tournament asks the referee to confirm. Then the snapshot records the final
    // score (so every screen shows it at once) but the match waits for an
    // explicit MATCH_ENDED. Explicit end events above always finalise.
    if (!finalize && e.new_state.matchOver && e.new_state.winner && !requiresConfirmation) {
      finalize = { status: "completed", winner: winnerTeamId(match, e.new_state) ?? "" };
    }
    // Undo past the end reopens the match (spec §4.5 "Match reopened")
    if (e.event_type === "UNDO" && !e.new_state.matchOver) {
      finalize = null;
      const wasFinished = ["completed", "walkover", "disqualified", "retired"].includes(match.status);
      if (wasFinished) {
        // The knockout or tie checks for this reopen already ran before any insert.
        statusUpdate = { ...statusUpdate, status: "live", winner_team_id: null, ended_at: null };
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
  if (Object.keys(statusUpdate).length > 0 && !finalize) {
    await db()
      .from("matches")
      .update({ ...statusUpdate, updated_at: new Date().toISOString() })
      .eq("id", matchId);
    // Reopening a finished match un-does whatever it awarded.
    if ("winner_team_id" in statusUpdate) {
      if (match.tie_id) {
        const { applyTieResult } = await import("@/lib/tennis/tieOps");
        await applyTieResult(match.tie_id);
      } else if (match.stage === "group") {
        const { recalcStandings } = await import("@/lib/ops");
        await recalcStandings(match.tournament_id);
      } else if (match.stage === "friendly") {
        // Its ledger rows must go, or players keep points for a match that is
        // no longer finished — and every affected player's fire streak has to
        // be replayed, since removing a result changes the whole sequence.
        const { revertFriendlyResult } = await import("@/lib/friendly/ops");
        await revertFriendlyResult(matchId, "referee");
      }
    }
  }
  // A retry whose events were all stored already carries nothing fresh, so a
  // finalise that failed the first time was never attempted again and the match
  // stayed live with a finished score. Reconcile from the stored state instead.
  if (!finalize && fresh.length === 0 && !requiresConfirmation && ["live", "paused", "pending_sync"].includes(match.status)) {
    const stored = (snapshot?.snapshot_json ?? null) as EngineStateLike | null;
    if (stored?.matchOver && stored.winner) {
      finalize = { status: "completed", winner: winnerTeamId(match, stored) ?? "" };
    }
  }
  if (finalize && finalize.winner) {
    await finalizeMatch(match, {
      status: finalize.status,
      winnerTeamId: finalize.winner,
      actorRole: role ?? "referee",
    });
  }
  if (startedNow && !finalize) {
    after(() => notifyMatchLive(match));
  }

  // iPhone lock-screen scores following this match.
  if (fresh.length > 0) {
    after(async () => {
      try {
        const { getConfig } = await import("@/lib/mobile/server");
        if (!(await getConfig()).flags.live_activity) return;
        const [{ pushLiveActivities, liveState }, { toScore }, { getSnapshot: snap }] = await Promise.all([
          import("@/lib/notify/apns"),
          import("@/lib/mobile/projection"),
          import("@/lib/data"),
        ]);
        const latest = await snap(matchId);
        const { data: names } = await db().from("teams").select("id, team_name, nation_code").in("id", [match.team_a_id, match.team_b_id].filter(Boolean) as string[]);
        const label = (id: string | null) => {
          const t = ((names ?? []) as { id: string; team_name: string; nation_code: string | null }[]).find((x) => x.id === id);
          return t?.nation_code ?? t?.team_name ?? "";
        };
        const ended = Boolean(finalize?.winner);
        const gameChanged = fresh.some((e) => e.event_type !== "POINT_AWARDED") || (finalState?.teamA?.points === "0" && finalState?.teamB?.points === "0");
        await pushLiveActivities(
          matchId,
          liveState(toScore(match, latest), { a: label(match.team_a_id), b: label(match.team_b_id), court: "", status: ended ? "Final" : "Live" }),
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
    after(async () => {
      try {
        const [{ getTeams, tierForMatch }, { scoringConfigForMatch, isDoublesMatch }] = await Promise.all([
          import("@/lib/data"),
          import("@/lib/scoring/rules"),
        ]);
        let config = null;
        if (ownerRow?.sport !== "chess") {
          const [teams, tier, { data: t }] = await Promise.all([
            getTeams(match.tournament_id),
            tierForMatch(match),
            db().from("tournaments").select("sport, scoring_config").eq("id", match.tournament_id).maybeSingle(),
          ]);
          const a = teams.find((x) => x.id === match.team_a_id);
          const b = teams.find((x) => x.id === match.team_b_id);
          config = scoringConfigForMatch(t as never, match, tier, {
            doubles: match.rubber_type ? match.rubber_type === "D" : isDoublesMatch(a, b),
          });
        }
        const issues = shadowMismatches(fresh, { snapshotState: priorState, teamA: match.team_a_id, config });
        if (issues.length) {
          const { audit } = await import("@/lib/audit");
          await audit({
            tournament_id: match.tournament_id,
            actor_role: role,
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

  return NextResponse.json({
    ok: true,
    applied,
    last_event_number: lastApplied,
    // The organiser can switch red and blue teams during a match. The scoring page
    // never reloads, so each sync tells it the current setting: the walls and the
    // voice switch together, from the next point.
    red_blue_teams: ownerRow?.branding_config?.redBlueTeams === true,
  });
}

import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { currentRole, can } from "@/lib/auth";
import { getMatch, getSnapshot } from "@/lib/data";
import { finalizeMatch, upsertSnapshotFromState, type EngineStateLike } from "@/lib/ops";
import type { Match } from "@/lib/types";

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
  if (!deviceId || events.length === 0) {
    return NextResponse.json({ error: "deviceId and events required" }, { status: 400 });
  }

  const match = await getMatch(matchId);
  if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 });
  if (match.active_scoring_device_id && match.active_scoring_device_id !== deviceId) {
    return NextResponse.json(
      { error: "Another device controls this match", conflict: "device_lock" },
      { status: 409 }
    );
  }
  if (!match.active_scoring_device_id) {
    await db().from("matches").update({ active_scoring_device_id: deviceId }).eq("id", matchId);
  }

  const snapshot = await getSnapshot(matchId);
  let lastApplied = snapshot?.last_event_number ?? 0;
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

  const fresh = events
    .filter((e) => !existing.has(e.client_event_id))
    .sort((a, b) => a.event_number - b.event_number);
  const applied: string[] = [];
  let finalState: EngineStateLike | null = null;
  let statusUpdate: Record<string, unknown> = {};
  let finalize: { status: "completed" | "walkover" | "disqualified" | "retired"; winner: string } | null = null;

  for (const e of fresh) {
    if (e.event_number !== lastApplied + 1) {
      // Sequence mismatch — another device or lost events (spec §18.9)
      return NextResponse.json(
        {
          error: `Event sequence mismatch: expected ${lastApplied + 1}, got ${e.event_number}`,
          conflict: "sequence",
          applied,
        },
        { status: 409 }
      );
    }
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
        // Reopening a knockout match has to take the winner back out of the next
        // round. Without this the bracket kept the retracted team and the next
        // match kept it as a side, so a wall showing the bracket showed a
        // pairing that was no longer true. Refused outright once that next match
        // has started, because silently rewriting a match in progress is worse
        // than making the referee resolve it.
        if (match.stage !== "group" && match.stage !== "friendly") {
          const { retractKnockout } = await import("@/lib/ops");
          const retraction = await retractKnockout(match);
          if (!retraction.ok) {
            return NextResponse.json(
              {
                error:
                  "The next round has already started, so this result cannot be undone. Correct the later match first.",
                conflict: retraction.reason,
                applied,
              },
              { status: 409 },
            );
          }
        }
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
      if (match.stage === "group") {
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
  if (finalize && finalize.winner) {
    await finalizeMatch(match, {
      status: finalize.status,
      winnerTeamId: finalize.winner,
      actorRole: role ?? "referee",
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

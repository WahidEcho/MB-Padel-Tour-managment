"use client";

import { getDeviceId, offlineDb, type LocalScoreEvent } from "./db";
import { MAX_EVENTS_PER_BATCH } from "../scoring/eventGuard";

/**
 * Points this browser scored that have not reached the server yet, by match, and
 * a "Send now" outside the scoring screen (the court QR page and the sign-in form
 * check them before a referee switches courts: src/app/r, src/lib/auth/staff.ts).
 */
export async function pendingMatchIds(): Promise<string[]> {
  try {
    const rows = await offlineDb.events.where("sync_status").equals("pending").toArray();
    return [...new Set(rows.map((e) => e.match_id))];
  } catch {
    // No IndexedDB (a private window): nothing can be queued here either.
    return [];
  }
}

/** Matches this browser has open and unfinished (a local score that is not over). */
export async function openMatchIds(): Promise<string[]> {
  try {
    const rows = await offlineDb.matchState.toArray();
    return rows.filter((r) => !["completed", "walkover", "disqualified", "retired", "cancelled"].includes(r.match_status) && !r.state?.matchOver).map((r) => r.match_id);
  } catch {
    return [];
  }
}

/**
 * Sends every match's queued points in order with this browser's device id. A match
 * whose points are refused (another device holds it now, the lease lapsed, the code
 * no longer reaches it) keeps them: the referee opens that match to sort it out.
 */
export async function sendPendingNow(): Promise<{ left: string[] }> {
  const ids = await pendingMatchIds();
  const deviceId = getDeviceId();
  const left: string[] = [];
  for (const matchId of ids) {
    const all = await offlineDb.events.where("match_id").equals(matchId).and((e) => e.sync_status === "pending").sortBy("event_number");
    if (!all.length) continue;
    if (!(await sendBatches(matchId, deviceId, all))) left.push(matchId);
  }
  return { left };
}

async function sendBatches(matchId: string, deviceId: string, all: LocalScoreEvent[]): Promise<boolean> {
  for (let i = 0; i < all.length; i += MAX_EVENTS_PER_BATCH) {
    const pending = all.slice(i, i + MAX_EVENTS_PER_BATCH);
    try {
      const res = await fetch(`/api/matches/${matchId}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId,
          events: pending.map((e) => ({
            client_event_id: e.client_event_id,
            event_number: e.event_number,
            event_type: e.event_type,
            team_id: e.team_id,
            previous_state: e.previous_state,
            new_state: e.new_state,
            payload: e.payload,
            created_at_client: e.created_at_client,
          })),
        }),
      });
      if (!res.ok) return false;
      await offlineDb.events.bulkPut(pending.map((e) => ({ ...e, sync_status: "synced" as const })));
    } catch {
      return false;
    }
  }
  return true;
}

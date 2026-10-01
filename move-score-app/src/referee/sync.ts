/**
 * Sends a match's queued events to the server, in order, one request at a time.
 * Handles the server's three answers the way the web console does, plus the
 * recovery the web console lacks: after a sequence conflict, if the server
 * already holds what this phone sent, the queue is marked done instead of stuck.
 */
import { api, ApiError } from "../api/client";
import { sameState } from "@core";
import { queue } from "./queue";

export type SyncState =
  | { kind: "synced" }
  | { kind: "syncing"; pending: number }
  | { kind: "pending"; pending: number }
  | { kind: "offline"; pending: number }
  | { kind: "conflict"; reason: "device_lock" | "sequence" | "other"; message: string; pending: number }
  | { kind: "signed_out"; pending: number };

const BATCH = 50;

export function createSyncer(matchId: string, deviceId: string, onState: (s: SyncState) => void, onRedBlue?: (on: boolean) => void) {
  let running = false;
  let again = false;
  let backoff = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  async function once(): Promise<void> {
    const pending = await queue().pending(matchId);
    if (!pending.length) {
      onState({ kind: "synced" });
      backoff = 0;
      return;
    }
    const batch = pending.slice(0, BATCH);
    onState({ kind: "syncing", pending: pending.length });
    try {
      const r = await api<{ applied: string[]; last_event_number: number; red_blue_teams?: boolean }>(`/api/matches/${matchId}/events`, {
        who: "staff",
        timeoutMs: 15_000,
        body: {
          deviceId,
          events: batch.map((e) => ({
            client_event_id: e.client_event_id,
            event_number: e.event_number,
            event_type: e.event_type,
            team_id: e.team_id,
            previous_state: e.previous_state,
            new_state: e.new_state,
            payload: e.payload,
            created_at_client: e.created_at_client,
          })),
        },
      });
      await queue().mark(batch.map((e) => e.client_event_id), "synced");
      if (typeof r.red_blue_teams === "boolean") onRedBlue?.(r.red_blue_teams);
      backoff = 0;
      if (pending.length > batch.length) again = true;
      else onState({ kind: "synced" });
    } catch (err) {
      const left = pending.length;
      if (err instanceof ApiError && err.status === 409) {
        const body = (err.body ?? {}) as { conflict?: string; applied?: string[]; error?: string };
        if (body.applied?.length) await queue().mark(body.applied, "synced");
        if (body.conflict === "sequence" && (await reconcile(batch))) {
          again = true;
          return;
        }
        onState({ kind: "conflict", reason: body.conflict === "device_lock" ? "device_lock" : body.conflict === "sequence" ? "sequence" : "other", message: body.error ?? "The server refused these points.", pending: left });
        return;
      }
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        onState({ kind: "signed_out", pending: left });
        return;
      }
      if (err instanceof ApiError && err.status === 400) {
        onState({ kind: "conflict", reason: "other", message: err.message, pending: left });
        return;
      }
      backoff = Math.min(30_000, backoff ? backoff * 2 : 3_000);
      onState({ kind: err instanceof ApiError ? "pending" : "offline", pending: left });
    }
  }

  /** The server may already have these events (a lost reply): if its state equals one we sent, everything up to it is done. */
  async function reconcile(batch: Awaited<ReturnType<ReturnType<typeof queue>["pending"]>>): Promise<boolean> {
    try {
      const s = await api<{ snapshot: { last_event_number: number; snapshot_json: unknown } | null }>(`/api/matches/${matchId}/state`);
      const n = s.snapshot?.last_event_number ?? 0;
      const hit = batch.find((e) => e.event_number === n);
      if (hit && sameState(hit.new_state, s.snapshot?.snapshot_json)) {
        await queue().mark(batch.filter((e) => e.event_number <= n).map((e) => e.client_event_id), "synced");
        return true;
      }
    } catch {
      /* offline */
    }
    return false;
  }

  async function run() {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await once();
      } while (again && !stopped);
    } finally {
      running = false;
    }
  }

  function loop() {
    if (stopped) return;
    timer = setTimeout(async () => {
      await run();
      loop();
    }, backoff || 6_000);
  }
  loop();

  return {
    syncNow: () => void run(),
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

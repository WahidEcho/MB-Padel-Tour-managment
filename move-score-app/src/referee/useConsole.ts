/**
 * The native scoring console's state: restores from the phone's queue, records
 * each action through the shared console logic (identical events to the web
 * console), writes it to SQLite in one transaction, then syncs.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import * as Crypto from "expo-crypto";
import * as Haptics from "expo-haptics";
import { Console, type EndsChange, type ScoreState, type TeamKey } from "@core";
import type { RefereeBootstrap } from "./types";
import { queue } from "./queue";
import { createSyncer, type SyncState } from "./sync";

const FINISHED = ["completed", "walkover", "disqualified", "retired", "cancelled"];

export interface RestClock {
  kind: NonNullable<EndsChange["kind"]>;
  changeEnds: boolean;
  endsAt: number;
}

export function useConsole(boot: RefereeBootstrap, deviceId: string, online: boolean) {
  const m = boot.match;
  const [state, setState] = useState<ScoreState | null>(null);
  const [status, setStatus] = useState<string>(m.status);
  const [sync, setSync] = useState<SyncState>({ kind: "synced" });
  const [rest, setRest] = useState<RestClock | null>(null);
  const [ready, setReady] = useState(false);
  const stateRef = useRef<ScoreState | null>(null);
  const historyRef = useRef<ScoreState[]>([]);
  const numberRef = useRef(boot.snapshot?.last_event_number ?? 0);
  const statusRef = useRef(m.status as string);
  const syncer = useRef<ReturnType<typeof createSyncer> | null>(null);

  const sideId = (k: TeamKey) => (k === "A" ? m.team_a_id : m.team_b_id);
  const opts = {
    config: boot.config,
    confirmFirst: boot.config.requireResultConfirmation === true,
    online,
    tennis: boot.tennis,
    doubles: boot.tennis && (boot.sideA?.players.length ?? 0) >= 2 && (boot.sideB?.players.length ?? 0) >= 2,
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      const local = await queue().match(m.id);
      const serverState = (boot.snapshot?.snapshot_json as ScoreState | null) ?? null;
      const serverNo = boot.snapshot?.last_event_number ?? 0;
      if (local && local.last_event_number >= serverNo) {
        stateRef.current = local.state;
        historyRef.current = local.history;
        numberRef.current = local.last_event_number;
        if (!FINISHED.includes(m.status)) statusRef.current = local.match_status;
      } else {
        stateRef.current = serverState;
        // A phone that takes over can still undo: the server sends the stack.
        historyRef.current = (boot.history as ScoreState[]).slice(-200);
        if (FINISHED.includes(m.status) && boot.reopenState && !historyRef.current.length) historyRef.current = [boot.reopenState as unknown as ScoreState];
      }
      if (!alive) return;
      setState(stateRef.current);
      setStatus(statusRef.current);
      setReady(true);
    })();
    syncer.current = createSyncer(m.id, deviceId, setSync);
    syncer.current.syncNow();
    return () => {
      alive = false;
      syncer.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.id, deviceId]);

  useEffect(() => {
    if (online) syncer.current?.syncNow();
  }, [online]);

  const record = useCallback(
    async (e: Console.ConsoleEvent | null) => {
      if (!e) return;
      const prev = stateRef.current;
      const n = ++numberRef.current;
      const history = Console.nextHistory(historyRef.current, prev, e.eventType);
      const nextStatus = e.newStatus ?? statusRef.current;
      const payload = e.winner ? { ...(e.payload ?? {}), winner_team_id: sideId(e.winner) } : e.payload;
      stateRef.current = e.next;
      historyRef.current = history;
      statusRef.current = nextStatus;
      setState(e.next);
      setStatus(nextStatus);
      if (e.ends?.kind) setRest({ kind: e.ends.kind, changeEnds: e.ends.changeEnds, endsAt: Date.now() + e.ends.restSeconds * 1000 });
      else if (e.eventType === "POINT_AWARDED") setRest((r) => (r && r.endsAt > Date.now() ? r : null));
      if (e.eventType === "UNDO") setRest(null);
      void Haptics.impactAsync(e.eventType === "POINT_AWARDED" ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      await queue().record(
        {
          client_event_id: Crypto.randomUUID(),
          match_id: m.id,
          event_number: n,
          event_type: e.eventType,
          team_id: e.team ? sideId(e.team) : null,
          previous_state: prev,
          new_state: e.next,
          payload,
          created_at_client: new Date().toISOString(),
          sync_status: "pending",
        },
        { match_id: m.id, state: e.next, history, last_event_number: n, match_status: nextStatus },
      );
      setSync((s) => ({ kind: "pending", pending: ("pending" in s ? s.pending : 0) + 1 }));
      syncer.current?.syncNow();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [m.id, online],
  );

  const cur = () => stateRef.current;
  return {
    ready,
    state,
    status,
    finished: FINISHED.includes(status),
    paused: status === "paused",
    canUndo: historyRef.current.length > 0,
    sync,
    rest,
    opts,
    clearRest: () => setRest(null),
    start: (first: TeamKey) => record(Console.startMatch(first)),
    needsConfirm: (k: TeamKey) => (cur() ? Console.pointNeedsConfirm(cur()!, k, opts) : null),
    point: (k: TeamKey) => cur() && record(Console.point(cur()!, k, opts)),
    confirmResult: () => cur() && record(Console.confirmResult(cur()!, opts)),
    undo: () => record(Console.undo(historyRef.current, FINISHED.includes(statusRef.current))),
    pause: () => cur() && record(Console.togglePause(cur()!, statusRef.current === "paused")),
    switchServer: () => cur() && record(Console.switchServer(cur()!)),
    swapServer: (k: TeamKey) => cur() && record(Console.swapServerInTeam(cur()!, k)),
    violation: (k: TeamKey, offence: Parameters<typeof Console.violation>[2]) => cur() && record(Console.violation(cur()!, k, offence, opts)),
    penaltyFor: (k: TeamKey, offence: Parameters<typeof Console.violation>[2]) => (cur() ? Console.violationPenalty(cur()!, k, offence) : "warning"),
    endSet: (k: TeamKey) => cur() && record(Console.endSet(cur()!, k, opts)),
    endWith: (kind: Console.EndKind, winner: TeamKey) => cur() && record(Console.endWith(cur()!, kind, winner, online)),
    syncNow: () => syncer.current?.syncNow(),
    /** Gives the match up: this phone's unsent points are kept but never sent. */
    abandonQueue: async () => {
      const p = await queue().pending(m.id);
      await queue().mark(p.map((e) => e.client_event_id), "abandoned");
      setSync({ kind: "synced" });
    },
  };
}

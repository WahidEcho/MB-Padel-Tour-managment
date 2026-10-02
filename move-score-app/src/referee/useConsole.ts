/**
 * The native scoring console's state: restores from the phone's queue, records
 * each action through the shared console logic (identical events to the web
 * console), writes it to SQLite in one transaction, then syncs.
 *
 * Every action runs on one chain, one after another: the event is built from
 * the score as it stands once the previous one is saved, and the score, undo
 * stack and event number move on only after the write has committed. A write
 * that fails changes nothing on screen and says so.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import * as Crypto from "expo-crypto";
import * as Haptics from "expo-haptics";
import { Console, type EndsChange, type MatchSnapshot, type ScoreState, type TeamKey } from "@core";
import { api } from "../api/client";
import type { RefereeBootstrap } from "./types";
import { queue, type LocalMatch } from "./queue";
import { createSyncer, type SyncState } from "./sync";

/** Statuses the server holds as over (the console's own list adds `pending_sync`). */
const SERVER_FINISHED = ["completed", "walkover", "disqualified", "retired", "cancelled"];

export interface RestClock {
  kind: NonNullable<EndsChange["kind"]>;
  changeEnds: boolean;
  endsAt: number;
}

/** The server's side of a match, as the bootstrap gives it. */
export interface ServerView {
  snapshot: MatchSnapshot | null;
  history: unknown[];
  status: string;
  reopenState: Record<string, unknown> | null;
}

/** This phone holds unsent points that do not follow on from the server's score. */
export interface RestoreQuestion {
  server: ServerView;
  serverNo: number;
  pending: number;
  first: number;
  last: number;
}

const fromBoot = (b: RefereeBootstrap): ServerView => ({ snapshot: b.snapshot, history: b.history, status: b.match.status, reopenState: b.reopenState });

const NOT_SAVED = "That was not saved on this phone, so nothing changed. Tap again.";
const ANSWER_FIRST = "Choose which score to carry on from first.";
const NEEDS_SERVER = "Load the server's score before scoring on (it needs signal).";

export function useConsole(boot: RefereeBootstrap, deviceId: string, online: boolean) {
  const m = boot.match;
  const [state, setState] = useState<ScoreState | null>(null);
  const [status, setStatus] = useState<string>(m.status);
  const [sync, setSync] = useState<SyncState>({ kind: "synced" });
  const [rest, setRest] = useState<RestClock | null>(null);
  const [ready, setReady] = useState(false);
  const [question, setQuestion] = useState<RestoreQuestion | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [blocked, setBlockedState] = useState<string | null>(null);
  const [undoDepth, setUndoDepth] = useState(0);
  const stateRef = useRef<ScoreState | null>(null);
  const historyRef = useRef<ScoreState[]>([]);
  const numberRef = useRef(boot.snapshot?.last_event_number ?? 0);
  const statusRef = useRef(m.status as string);
  const blockRef = useRef<string | null>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const syncer = useRef<ReturnType<typeof createSyncer> | null>(null);

  const sideId = (k: TeamKey) => (k === "A" ? m.team_a_id : m.team_b_id);
  const opts = {
    config: boot.config,
    confirmFirst: boot.config.requireResultConfirmation === true,
    online,
    tennis: boot.tennis,
    doubles: boot.tennis && (boot.sideA?.players.length ?? 0) >= 2 && (boot.sideB?.players.length ?? 0) >= 2,
  };
  const confirmFirst = opts.confirmFirst;

  /** Runs after everything queued before it, whatever that did. */
  const enqueue = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.current.then(fn, fn);
    chain.current = run.catch(() => undefined);
    return run;
  }, []);

  const setBlocked = (why: string | null) => {
    blockRef.current = why;
    setBlockedState(why);
  };
  const show = () => {
    setState(stateRef.current);
    setStatus(statusRef.current);
    setUndoDepth(historyRef.current.length);
  };
  const takeServer = (v: ServerView) => {
    stateRef.current = (v.snapshot?.snapshot_json as ScoreState | null) ?? null;
    // A phone that takes over can still undo: the server sends the stack.
    historyRef.current = (v.history as ScoreState[]).slice(-200);
    if (SERVER_FINISHED.includes(v.status) && v.reopenState && !historyRef.current.length) historyRef.current = [v.reopenState as unknown as ScoreState];
    numberRef.current = v.snapshot?.last_event_number ?? 0;
    statusRef.current = v.status;
  };
  const takeLocal = (local: LocalMatch, pending: number, v: ServerView) => {
    stateRef.current = local.state;
    historyRef.current = local.history;
    numberRef.current = local.last_event_number;
    // Unsent events (an offline result, or an undo that reopens) outrank the server's status.
    statusRef.current = pending > 0 || !SERVER_FINISHED.includes(v.status) ? local.match_status : v.status;
  };

  /** Picks the phone's score or the server's (or asks), on the chain. */
  const restore = useCallback(
    (v: ServerView) =>
      enqueue(async () => {
        const [local, rows] = await Promise.all([queue().match(m.id), queue().events(m.id)]);
        const serverNo = v.snapshot?.last_event_number ?? 0;
        const pending = rows.filter((r) => r.sync_status === "pending");
        const choice = Console.restoreChoice({
          serverNo,
          serverState: v.snapshot?.snapshot_json ?? null,
          localNo: local?.last_event_number ?? null,
          rows: rows.map((r) => ({ n: r.event_number, pending: r.sync_status === "pending", state: r.new_state })),
        });
        if (choice === "local" && local) takeLocal(local, pending.length, v);
        else if (choice === "ask" && local) takeLocal(local, pending.length, v);
        else takeServer(v);
        if (choice === "ask") {
          setQuestion({ server: v, serverNo, pending: pending.length, first: pending[0]?.event_number ?? 0, last: pending.at(-1)?.event_number ?? 0 });
          setBlocked(ANSWER_FIRST);
        } else {
          setQuestion(null);
          setBlocked(null);
        }
        show();
        return choice;
      }),
    [m.id, enqueue],
  );

  const fetchServer = useCallback(async (): Promise<ServerView | null> => {
    try {
      return fromBoot(await api<RefereeBootstrap>(`/api/mobile/v1/referee/matches/${m.id}/bootstrap`, { who: "staff", timeoutMs: 10_000 }));
    } catch {
      return null;
    }
  }, [m.id]);

  useEffect(() => {
    let alive = true;
    void restore(fromBoot(boot)).finally(() => {
      if (alive) setReady(true);
    });
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
    (build: () => Console.ConsoleEvent | null) =>
      enqueue(async (): Promise<boolean> => {
        if (blockRef.current) {
          setWriteError(blockRef.current);
          return false;
        }
        const prev = stateRef.current;
        const e = build();
        if (!e) return false;
        // A finished match takes nothing but Undo (the server refuses the rest).
        if (e.eventType !== "UNDO" && Console.isFinished(statusRef.current, prev, confirmFirst)) return false;
        const n = numberRef.current + 1;
        const history = Console.nextHistory(historyRef.current, prev, e.eventType);
        const nextStatus = e.newStatus ?? statusRef.current;
        const payload = e.winner ? { ...(e.payload ?? {}), winner_team_id: sideId(e.winner) } : e.payload;
        try {
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
        } catch {
          setWriteError(NOT_SAVED);
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
          return false;
        }
        // Saved: only now does the console move on.
        numberRef.current = n;
        stateRef.current = e.next;
        historyRef.current = history;
        statusRef.current = nextStatus;
        setWriteError(null);
        setState(e.next);
        setStatus(nextStatus);
        setUndoDepth(history.length);
        if (e.ends?.kind) setRest({ kind: e.ends.kind, changeEnds: e.ends.changeEnds, endsAt: Date.now() + e.ends.restSeconds * 1000 });
        else if (e.eventType === "POINT_AWARDED") setRest((r) => (r && r.endsAt > Date.now() ? r : null));
        if (e.eventType === "UNDO") setRest(null);
        void Haptics.impactAsync(e.eventType === "POINT_AWARDED" ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        setSync((s) => ({ kind: "pending", pending: ("pending" in s ? s.pending : 0) + 1 }));
        syncer.current?.syncNow();
        return true;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [m.id, enqueue, confirmFirst],
  );

  /** Gives up this phone's unsent points and carries on from the server's score. */
  const dropLocal = useCallback(
    async (v: ServerView | null) => {
      await enqueue(async () => {
        await queue().abandon(m.id);
        await queue().forget(m.id);
        if (v) {
          takeServer(v);
          setBlocked(null);
        } else {
          // Offline: the server's score is unknown, so nothing more is recorded until it is loaded.
          setBlocked(NEEDS_SERVER);
        }
        setQuestion(null);
        show();
      });
      setSync({ kind: "synced" });
      syncer.current?.syncNow();
    },
    [m.id, enqueue],
  );

  const cur = () => stateRef.current;
  return {
    ready,
    state,
    status,
    finished: Console.isFinished(status, state, confirmFirst),
    paused: status === "paused",
    canUndo: undoDepth > 0,
    sync,
    rest,
    opts,
    question,
    writeError,
    blocked,
    clearWriteError: () => setWriteError(null),
    clearRest: () => setRest(null),
    start: (first: TeamKey) => record(() => Console.startMatch(first)),
    needsConfirm: (k: TeamKey) => (cur() ? Console.pointNeedsConfirm(cur()!, k, opts) : null),
    point: (k: TeamKey) => record(() => (cur() ? Console.point(cur()!, k, opts) : null)),
    confirmResult: () => record(() => (cur() ? Console.confirmResult(cur()!, opts) : null)),
    undo: () => record(() => Console.undo(historyRef.current, Console.isFinished(statusRef.current, stateRef.current, confirmFirst))),
    pause: () => record(() => (cur() ? Console.togglePause(cur()!, statusRef.current === "paused") : null)),
    switchServer: () => record(() => (cur() ? Console.switchServer(cur()!) : null)),
    swapServer: (k: TeamKey) => record(() => (cur() ? Console.swapServerInTeam(cur()!, k) : null)),
    violation: (k: TeamKey, offence: Parameters<typeof Console.violation>[2]) => record(() => (cur() ? Console.violation(cur()!, k, offence, opts) : null)),
    penaltyFor: (k: TeamKey, offence: Parameters<typeof Console.violation>[2]) => (cur() ? Console.violationPenalty(cur()!, k, offence) : "warning"),
    endSet: (k: TeamKey) => record(() => (cur() ? Console.endSet(cur()!, k, opts) : null)),
    endWith: (kind: Console.EndKind, winner: TeamKey) => record(() => (cur() ? Console.endWith(cur()!, kind, winner, online) : null)),
    syncNow: () => syncer.current?.syncNow(),
    /** Waits for every saved tap, then sends them all. True only when the server has every one. */
    drain: async (): Promise<boolean> => {
      await chain.current;
      return (await syncer.current?.flush()) ?? false;
    },
    /** This phone scored the match: it has its own copy or points still to send. */
    hasLocalWork: async (): Promise<boolean> => Boolean(await queue().match(m.id)) || (await queue().pending(m.id)).length > 0,
    /** Gained control: load the server's score and carry on from whichever is right. False when offline. */
    reload: async (): Promise<boolean> => {
      const v = await fetchServer();
      if (!v) return false;
      await restore(v);
      return true;
    },
    /** The phone's score and the server's disagree: carry on with the phone's. */
    keepLocal: () =>
      enqueue(async () => {
        setQuestion(null);
        setBlocked(null);
      }),
    /** Throws away this phone's unsent points and loads the server's score. False when offline. */
    loadServerScore: async (): Promise<boolean> => {
      const v = await fetchServer();
      if (!v) {
        setWriteError("No signal: the server's score could not be loaded. Try again.");
        return false;
      }
      await dropLocal(v);
      return true;
    },
    /** Gives the match up: this phone's unsent points are kept apart, never sent, and its score goes back to the server's. */
    abandonQueue: async () => {
      await dropLocal(await fetchServer());
    },
  };
}

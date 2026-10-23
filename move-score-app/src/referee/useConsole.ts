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
import {
  Console,
  RESULT_ENTERED,
  queueableResult,
  resultPayloadOf,
  type EndsChange,
  type MatchSnapshot,
  type ResultPayload,
  type ResultProblem,
  type ResultRejection,
  type ScoreState,
  type ServeOrder,
  type TeamKey,
  type TimeDecision,
  type TimerKind,
  SCORING_FEATURES_OFF,
} from "@core";
import { api, ApiError } from "../api/client";
import { getLang, tr } from "../i18n/t";
import { problemText } from "./scoreWords";
import type { RefereeBootstrap } from "./types";
import { queue, type LocalMatch, type QueuedEvent } from "./queue";
import { createSyncer, type SyncState } from "./sync";

/** Statuses the server holds as over (the console's own list adds `pending_sync`). */
const SERVER_FINISHED = ["completed", "walkover", "disqualified", "retired", "cancelled"];

/** Scoring v2: the timer running on the console (timing.ts). The 25 s is not recorded; the others are. */
export interface RunningTimer {
  kind: TimerKind;
  startedAt: number;
  team: TeamKey | null;
  recorded: boolean;
}

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

/** A final result that was not recorded: the form opens again, filled in, with why. */
export interface ResultRefusal {
  message: string;
  problems: ResultProblem[];
  initial: ResultPayload | null;
}

const fromBoot = (b: RefereeBootstrap): ServerView => ({ snapshot: b.snapshot, history: b.history, status: b.match.status, reopenState: b.reopenState });

// Read when shown, so they come in the language on screen.
const NOT_SAVED = () => tr("score.notSaved");
const ANSWER_FIRST = () => tr("score.answerFirst");
const NEEDS_SERVER = () => tr("score.needsServer");

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
  const [refusal, setRefusal] = useState<ResultRefusal | null>(null);
  /** The undo stack before each queued result (a result empties it), to put back if the server refuses the result. */
  const beforeResult = useRef(new Map<string, ScoreState[]>());
  // Scoring v2: the organiser's switches, and the timer on this console.
  const features = boot.matchDay?.features ?? SCORING_FEATURES_OFF;
  const [timer, setTimerState] = useState<RunningTimer | null>(null);
  const timerRef = useRef<RunningTimer | null>(null);
  const setTimer = (v: RunningTimer | null) => {
    timerRef.current = v;
    setTimerState(v);
  };
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
    // A recorded timer still running in the score (the phone reopened, or took the match over).
    const running = Console.runningClock(stateRef.current);
    const started = running ? Date.parse(running.startedAt) : NaN;
    if (running && !stateRef.current?.matchOver && Number.isFinite(started) && Date.now() - started < 30 * 60_000) {
      setTimer({ kind: running.kind, startedAt: started, team: running.team, recorded: true });
    } else if (timerRef.current?.recorded) setTimer(null);
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
          setBlocked(ANSWER_FIRST());
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
    syncer.current = createSyncer(m.id, deviceId, setSync, { onResultRefused: (r) => resultRefused(r) });
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
        // A final result supersedes the points before it: nothing to undo back into (as on the server and the web).
        const history = e.eventType === RESULT_ENTERED ? [] : Console.nextHistory(historyRef.current, prev, e.eventType);
        const clientEventId = Crypto.randomUUID();
        const nextStatus = e.newStatus ?? statusRef.current;
        const payload = e.winner ? { ...(e.payload ?? {}), winner_team_id: sideId(e.winner) } : e.payload;
        try {
          await queue().record(
            {
              client_event_id: clientEventId,
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
          setWriteError(NOT_SAVED());
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
          return false;
        }
        // Saved: only now does the console move on.
        if (e.eventType === RESULT_ENTERED) beforeResult.current.set(clientEventId, historyRef.current);
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
          setBlocked(NEEDS_SERVER());
        }
        setQuestion(null);
        show();
      });
      setSync({ kind: "synced" });
      syncer.current?.syncNow();
    },
    [m.id, enqueue],
  );

  /**
   * The server refused a queued final result (sync.ts has taken it, and anything
   * after it, out of the queue): back to the score before it, and the form again.
   */
  const resultRefused = (r: ResultRejection<QueuedEvent>) =>
    enqueue(async () => {
      const restore = (r.restore as ScoreState | null) ?? null;
      historyRef.current = beforeResult.current.get(r.result.client_event_id) ?? [];
      beforeResult.current.delete(r.result.client_event_id);
      stateRef.current = restore;
      numberRef.current = r.lastEventNumber;
      statusRef.current = restore ? (restore.matchOver ? statusRef.current : "live") : m.status;
      try {
        if (restore || r.lastEventNumber > 0) {
          await queue().saveMatch({ match_id: m.id, state: restore, history: historyRef.current, last_event_number: r.lastEventNumber, match_status: statusRef.current });
        } else {
          await queue().forget(m.id);
        }
      } catch {
        /* the phone's copy is rebuilt from the server on the next open */
      }
      show();
      setRefusal({ message: tr("score.resultNotRecorded", { message: getLang() !== "en" && r.problems[0] ? problemText(r.problems[0]) : r.message }), problems: r.problems, initial: resultPayloadOf(r.result) });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
    });

  /**
   * A final result typed in one go (games sports). Checked here with the match's
   * own rules before it is queued, so a result the rules cannot produce never
   * enters the queue; then it goes through the queue like a point (offline too).
   */
  const enterResult = async (payload: ResultPayload): Promise<{ ok: true } | { ok: false; message: string; problems: ResultProblem[] }> => {
    const q = queueableResult({ mode: boot.scoringMode ?? "point_by_point", engine: "games", rules: boot.config, payload });
    if (!q.ok) return { ok: false, message: q.problems[0] ? problemText(q.problems[0]) : tr("score.checkTheScore"), problems: q.problems };
    setRefusal(null);
    const saved = await record(() => ({
      eventType: RESULT_ENTERED,
      next: q.state as ScoreState,
      team: q.winner,
      payload: q.payload as unknown as Record<string, unknown>,
      newStatus: q.over ? (online ? "completed" : "pending_sync") : "live",
    }));
    return saved ? { ok: true } : { ok: false, message: blockRef.current ?? NOT_SAVED(), problems: [] };
  };

  /**
   * A result sent straight to the server, never queued: correcting a finished
   * match (the server reopens and re-finalises it) and chess results. Needs a
   * connection. On success the console carries on from the server's score.
   */
  const sendResultNow = async (event: { payload: ResultPayload; state: unknown; winner: TeamKey | null }): Promise<{ ok: true } | { ok: false; message: string; problems: ResultProblem[] }> => {
    try {
      // Everything this phone holds goes first, so the result lands after it.
      if (!(await (async () => {
        await chain.current;
        return (await syncer.current?.flush()) ?? true;
      })())) {
        return { ok: false, message: tr("score.sendFirst"), problems: [] };
      }
      const st = await api<{ snapshot: MatchSnapshot | null }>(`/api/matches/${m.id}/state`, { who: "staff", timeoutMs: 10_000 });
      await api(`/api/matches/${m.id}/events`, {
        who: "staff",
        timeoutMs: 15_000,
        body: {
          deviceId,
          events: [
            {
              client_event_id: Crypto.randomUUID(),
              event_number: (st.snapshot?.last_event_number ?? 0) + 1,
              event_type: RESULT_ENTERED,
              team_id: event.winner ? sideId(event.winner) : null,
              previous_state: st.snapshot?.snapshot_json ?? null,
              new_state: event.state,
              payload: event.payload,
              created_at_client: new Date().toISOString(),
            },
          ],
        },
      });
    } catch (e) {
      if (e instanceof ApiError && e.status !== 0) {
        const body = (e.body ?? {}) as { problems?: ResultProblem[] };
        return { ok: false, message: e.message, problems: Array.isArray(body.problems) ? body.problems : [] };
      }
      return { ok: false, message: tr("score.needsConnection"), problems: [] };
    }
    setRefusal(null);
    const v = await fetchServer();
    if (v) await dropLocal(v);
    return { ok: true };
  };

  const cur = () => stateRef.current;

  /* ---------------- scoring v2 ---------------- */
  const opts2 = () => ({ ...opts, doubles: (boot.sideA?.players.length ?? 0) >= 2 && (boot.sideB?.players.length ?? 0) >= 2 });

  /**
   * Stops a recorded timer still running (changeover, set break, a break) before play goes on.
   * `keepBetween`: a scoring step leaves the 25 s banner up until the next one replaces it,
   * so the console never loses the banner for a frame (the whole screen jumped twice a point).
   */
  const stopRunning = async (keepBetween = false) => {
    const running = Console.runningClock(stateRef.current);
    if (running && !stateRef.current?.matchOver) {
      const started = Date.parse(running.startedAt);
      await record(() => (cur() ? Console.timerStop(cur()!, running.kind, (Date.now() - (Number.isFinite(started) ? started : Date.now())) / 1000, running.team) : null));
    }
    const t = timerRef.current;
    if (t && !(keepBetween && !t.recorded && t.kind === "between_points")) setTimer(null);
  };

  /** After a step that moved the score: the changeover / set break (recorded) or the 25 s (here only). */
  const follow = async (e: Console.ConsoleEvent) => {
    const next = Console.followingTimer(e.after, features);
    if (!next || e.next.matchOver) return setTimer(null);
    const at = Date.now();
    if (next.record) await record(() => (cur() ? Console.timerStart(cur()!, next.kind, new Date(at).toISOString()) : null));
    setTimer({ kind: next.kind, startedAt: at, team: null, recorded: next.record });
  };

  /** A scoring step: stop a running timer, record, then start what follows. */
  const step = async (build: () => Console.ConsoleEvent | null): Promise<boolean> => {
    await stopRunning(true);
    let built: Console.ConsoleEvent | null = null;
    const ok = await record(() => (built = build()));
    const e = built as Console.ConsoleEvent | null;
    if (ok && e?.after?.timer) await follow(e);
    // Nothing follows (or the step was refused): the 25 s banner kept above goes now.
    else if (timerRef.current && !timerRef.current.recorded) setTimer(null);
    return ok;
  };

  /** Which side a fault or an ace would score for, and whether that point needs the "about to win" check. */
  const v2Confirm = (action: "ace" | "fault"): { team: TeamKey; what: string } | null => {
    const s = cur();
    if (!s) return null;
    const e = action === "ace" ? Console.aceEvent(s, opts2()) : Console.faultEvent(s, opts2());
    if (!e || e.eventType !== "POINT_AWARDED" || !e.team) return null;
    const what = Console.pointNeedsConfirm(s, e.team, opts2());
    return what ? { team: e.team, what } : null;
  };

  const decide = async (decision: TimeDecision, team: TeamKey | null) => {
    const t = timerRef.current;
    if (!t) return;
    const seconds = (Date.now() - t.startedAt) / 1000;
    await record(() => (cur() ? Console.timeDecision(cur()!, t.kind, decision, seconds, team) : null));
    if (t.recorded) await stopRunning();
    else setTimer(null);
    if (decision === "code_violation" && team) await step(() => (cur() ? Console.violation(cur()!, team, "time", opts) : null));
  };

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
    /** The server refused a final result this phone queued: reopen the form with this. */
    refusal,
    clearRefusal: () => setRefusal(null),
    enterResult,
    sendResultNow,
    clearRest: () => setRest(null),
    /* scoring v2 */
    features,
    timer,
    v2Confirm,
    fault: () => step(() => (cur() ? Console.faultEvent(cur()!, opts2()) : null)),
    ace: () => step(() => (cur() ? Console.aceEvent(cur()!, opts2()) : null)),
    callLet: (kind: "serve" | "point") => record(() => (cur() ? Console.letEvent(cur()!, kind) : null)),
    serveOrder: (o: ServeOrder) => record(() => (cur() ? Console.serveOrderEvent(cur()!, o) : null)),
    startBreak: async (kind: TimerKind, team: TeamKey | null) => {
      await stopRunning();
      const at = Date.now();
      const ok = await record(() => (cur() ? Console.timerStart(cur()!, kind, new Date(at).toISOString(), team) : null));
      if (ok) setTimer({ kind, startedAt: at, team, recorded: true });
    },
    endTimer: async () => {
      if (timerRef.current?.recorded) await stopRunning();
      else setTimer(null);
    },
    decide,
    start: (first: TeamKey) => record(() => Console.startMatch(first)),
    needsConfirm: (k: TeamKey) => (cur() ? Console.pointNeedsConfirm(cur()!, k, opts) : null),
    point: (k: TeamKey) => step(() => (cur() ? Console.point(cur()!, k, opts) : null)),
    confirmResult: () => record(() => (cur() ? Console.confirmResult(cur()!, opts) : null)),
    undo: async () => {
      const ok = await record(() => Console.undo(historyRef.current, Console.isFinished(statusRef.current, stateRef.current, confirmFirst)));
      if (ok && timerRef.current && !timerRef.current.recorded) setTimer(null);
      return ok;
    },
    pause: () => record(() => (cur() ? Console.togglePause(cur()!, statusRef.current === "paused") : null)),
    switchServer: () => record(() => (cur() ? Console.switchServer(cur()!) : null)),
    swapServer: (k: TeamKey) => record(() => (cur() ? Console.swapServerInTeam(cur()!, k) : null)),
    violation: (k: TeamKey, offence: Parameters<typeof Console.violation>[2]) => step(() => (cur() ? Console.violation(cur()!, k, offence, opts) : null)),
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
        setWriteError(tr("score.noSignalServer"));
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

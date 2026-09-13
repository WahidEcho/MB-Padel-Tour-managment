"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  awardPoint,
  changeServer,
  initialScoreState,
  manualEndSet,
  pointOutcome,
  scoreSummary,
  type ScoreState,
  type TeamKey,
} from "@/lib/scoring/engine";
import type { MatchSnapshot, Match, PhotoFields, ScoringConfig } from "@/lib/types";
import { offlineDb, getDeviceId, type LocalScoreEvent } from "@/lib/offline/db";
import Avatar from "@/components/Avatar";
import { describeMatchRules } from "@/lib/scoring/rules";

interface TeamInfo {
  id: string;
  name: string;
  players: { name: string; photo: PhotoFields }[];
  checkedIn: boolean;
}

type Modal =
  | { kind: "confirm-point"; team: TeamKey; message: string }
  | { kind: "confirm-undo" }
  | { kind: "end-menu" }
  | { kind: "force-end"; winner: TeamKey | null }
  | { kind: "walkover"; absent: TeamKey | null }
  | { kind: "disqualify"; team: TeamKey | null }
  | { kind: "retire"; team: TeamKey | null }
  | { kind: "end-set"; team: TeamKey | null }
  | null;

const FINISHED = ["completed", "walkover", "disqualified", "retired", "cancelled"];

export default function ScoreClient({
  match,
  tournamentName,
  courtName,
  scoringConfig,
  teamA,
  teamB,
  serverSnapshot,
  reopenState = null,
}: {
  match: Match;
  tournamentName: string;
  courtName: string;
  scoringConfig: ScoringConfig;
  teamA: TeamInfo;
  teamB: TeamInfo;
  serverSnapshot: MatchSnapshot | null;
  /** The score before the winning point of a completed match, so this device can reopen it. */
  reopenState?: ScoreState | null;
}) {
  const [state, setState] = useState<ScoreState | null>(null);
  const [history, setHistory] = useState<ScoreState[]>([]);
  const [matchStatus, setMatchStatus] = useState(match.status);
  const [controller, setController] = useState<boolean | null>(null);
  const [online, setOnline] = useState(true);
  const [syncStatus, setSyncStatus] = useState<"synced" | "syncing" | "pending" | "error">("synced");
  const [syncError, setSyncError] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [elapsed, setElapsed] = useState("");
  const [startWarningAck, setStartWarningAck] = useState(false);
  const [popKey, setPopKey] = useState(0);

  const eventNumberRef = useRef(serverSnapshot?.last_event_number ?? 0);
  const startedAtRef = useRef<string | null>(match.started_at);
  const syncingRef = useRef(false);
  // Set when a sync is requested while one is already running, so the queue is
  // drained the moment that request returns instead of on the next timer.
  const resyncRef = useRef(false);
  const trySyncRef = useRef<(() => Promise<void>) | null>(null);
  const deviceIdRef = useRef<string>("");
  // Live mirrors of state/history so rapid taps never read stale React state
  const stateRef = useRef<ScoreState | null>(null);
  const historyRef = useRef<ScoreState[]>([]);

  const commit = useCallback((next: ScoreState | null, nextHistory: ScoreState[]) => {
    stateRef.current = next;
    historyRef.current = nextHistory;
    setState(next);
    setHistory(nextHistory);
  }, []);

  const finished = FINISHED.includes(matchStatus);
  const confirmFirst = scoringConfig.requireResultConfirmation === true;
  // The score says the match is over, but nobody has confirmed it yet.
  const awaitingConfirmation = confirmFirst && Boolean(state?.matchOver) && !finished;
  const team = useCallback((k: TeamKey) => (k === "A" ? teamA : teamB), [teamA, teamB]);

  /* ---------------- sync loop ---------------- */
  const trySync = useCallback(async () => {
    if (!navigator.onLine) return;
    if (syncingRef.current) {
      // A tap landed while a sync was already in flight. Before this, that tap
      // simply waited for the next six-second timer, so during a rally the venue
      // screen saw one point every six seconds however fast the referee scored.
      // Remember it, and drain as soon as the current request finishes.
      resyncRef.current = true;
      return;
    }
    const pending = await offlineDb.events
      .where("match_id").equals(match.id)
      .and((e) => e.sync_status === "pending")
      .sortBy("event_number");
    if (pending.length === 0) {
      setPendingCount(0);
      return;
    }
    syncingRef.current = true;
    setSyncStatus("syncing");
    try {
      const res = await fetch(`/api/matches/${match.id}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: deviceIdRef.current,
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
      if (res.ok) {
        await offlineDb.events.bulkPut(pending.map((e) => ({ ...e, sync_status: "synced" as const })));
        setPendingCount(0);
        setSyncStatus("synced");
        setSyncError(null);
      } else if (res.status === 409) {
        const data = await res.json();
        setSyncStatus("error");
        setSyncError(data.error ?? "Sync conflict — contact the tournament manager.");
      } else {
        setSyncStatus("pending");
      }
    } catch {
      setSyncStatus("pending");
    } finally {
      syncingRef.current = false;
      if (resyncRef.current) {
        resyncRef.current = false;
        // Queued, not awaited: the drain runs as its own request, in order,
        // and cannot overlap this one because the flag has just been released.
        queueMicrotask(() => void trySyncRef.current?.());
      }
    }
  }, [match.id]);

  useEffect(() => {
    trySyncRef.current = trySync;
  }, [trySync]);

  useEffect(() => {
    const id = setInterval(() => void trySync(), 6000);
    return () => clearInterval(id);
  }, [trySync]);


  /* ---------------- init: restore state, claim lock ---------------- */
  useEffect(() => {
    deviceIdRef.current = getDeviceId();

    async function init() {
      setOnline(navigator.onLine);
      const local = await offlineDb.matchState.get(match.id);
      const serverState = (serverSnapshot?.snapshot_json as ScoreState | null) ?? null;
      const serverEventNo = serverSnapshot?.last_event_number ?? 0;

      if (local && local.last_event_number >= serverEventNo) {
        commit(local.state, local.history);
        eventNumberRef.current = local.last_event_number;
        if (!FINISHED.includes(match.status)) setMatchStatus(local.match_status as Match["status"]);
      } else if (serverState) {
        commit(serverState, []);
      }
      const pend = await offlineDb.events
        .where("match_id").equals(match.id)
        .and((e) => e.sync_status === "pending")
        .count();
      setPendingCount(pend);
      if (pend > 0) setSyncStatus("pending");

      if (FINISHED.includes(match.status)) {
        // A finished match is read-only unless it can be reopened. Finalising
        // releases the lock, so any referee device may take it to undo the
        // winning point — the confirming tablet may be flat, or reloaded.
        if (!reopenState || match.status === "cancelled") {
          setController(false);
          return;
        }
        if (historyRef.current.length === 0) commit(stateRef.current, [reopenState]);
      }
      try {
        const res = await fetch(`/api/matches/${match.id}/claim`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceId: deviceIdRef.current }),
        });
        const data = await res.json();
        setController(Boolean(data.controller));
      } catch {
        // Offline on load: allow control if we already have local state for this match
        setController(Boolean(local) || match.active_scoring_device_id === deviceIdRef.current);
      }
    }
    init();

    const on = () => { setOnline(true); void trySync(); };
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match.id]);

  /* ---------------- timer ---------------- */
  useEffect(() => {
    const id = setInterval(() => {
      if (!startedAtRef.current || finished) return;
      const ms = Date.now() - new Date(startedAtRef.current).getTime();
      const m = Math.floor(ms / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      setElapsed(`${m}:${String(s).padStart(2, "0")}`);
    }, 1000);
    return () => clearInterval(id);
  }, [finished]);

  /* ---------------- event creation ---------------- */
  const pushEvent = useCallback(
    async (
      eventType: string,
      newState: ScoreState,
      opts: { teamId?: string | null; payload?: Record<string, unknown>; newStatus?: string } = {}
    ) => {
      const prev = stateRef.current;
      const n = ++eventNumberRef.current;
      const event: LocalScoreEvent = {
        client_event_id: crypto.randomUUID(),
        match_id: match.id,
        event_number: n,
        event_type: eventType,
        team_id: opts.teamId ?? null,
        previous_state: prev,
        new_state: newState,
        payload: opts.payload ?? null,
        created_at_client: new Date().toISOString(),
        sync_status: "pending",
      };
      const nextStatus = opts.newStatus ?? matchStatus;
      const nextHistory = (
        eventType === "UNDO"
          ? historyRef.current.slice(0, -1)
          : prev
            ? [...historyRef.current, prev]
            : historyRef.current
      ).slice(-200);
      commit(newState, nextHistory); // synchronous ref update first — taps can be rapid
      if (opts.newStatus) setMatchStatus(opts.newStatus as Match["status"]);
      setPendingCount((c) => c + 1);
      setSyncStatus(navigator.onLine ? "syncing" : "pending");
      setPopKey((k) => k + 1);
      await offlineDb.events.put(event);
      await offlineDb.matchState.put({
        match_id: match.id,
        state: newState,
        history: nextHistory,
        last_event_number: n,
        match_status: nextStatus,
        updated_at: new Date().toISOString(),
      });
      void trySync();
    },
    [match.id, matchStatus, trySync, commit]
  );

  /* ---------------- actions ---------------- */
  function startMatch(firstServer: TeamKey) {
    const s = initialScoreState(firstServer);
    startedAtRef.current = new Date().toISOString();
    void pushEvent("MATCH_STARTED", s, {
      newStatus: "live",
      payload: { first_server: firstServer },
    });
  }

  function tapScore(teamKey: TeamKey) {
    const cur = stateRef.current;
    if (!cur || finished || matchStatus === "paused") return;
    const outcome = pointOutcome(cur, teamKey, scoringConfig);
    // With result confirmation on, match point is not asked about twice: the
    // point lands, and the Confirm result card that follows is the check.
    if (outcome.winsMatch && confirmFirst) return applyPoint(teamKey);
    if (outcome.winsGame || outcome.winsSet || outcome.winsMatch) {
      const what = outcome.winsMatch ? "the MATCH" : outcome.winsSet ? "the set" : "this game";
      setModal({
        kind: "confirm-point",
        team: teamKey,
        message: `${team(teamKey).name} is about to win ${what}.`,
      });
      return;
    }
    applyPoint(teamKey);
  }

  function applyPoint(teamKey: TeamKey) {
    const cur = stateRef.current;
    if (!cur) return;
    const next = awardPoint(cur, teamKey, scoringConfig);
    // With confirmation on, the winning point records the score but does not end
    // the match: the referee confirms it first, so a mis-tap on match point is
    // caught before it reaches the standings, the bracket and the venue screen.
    const ended = next.matchOver && !confirmFirst;
    void pushEvent("POINT_AWARDED", next, {
      teamId: team(teamKey).id,
      newStatus: ended ? (navigator.onLine ? "completed" : "pending_sync") : undefined,
    });
    setModal(null);
  }

  /** Makes a finished score official. Sends the same MATCH_ENDED the route already finalises. */
  function confirmResult() {
    const cur = stateRef.current;
    if (!cur?.matchOver || !cur.winner) return;
    void pushEvent("MATCH_ENDED", cur, {
      teamId: team(cur.winner).id,
      payload: { winner_team_id: team(cur.winner).id },
      newStatus: navigator.onLine ? "completed" : "pending_sync",
    });
  }

  function doUndo() {
    const cur = stateRef.current;
    if (historyRef.current.length === 0 || !cur) return setModal(null);
    const prev = historyRef.current[historyRef.current.length - 1];
    void pushEvent("UNDO", prev, { newStatus: finished ? "live" : undefined });
    setModal(null);
  }

  function togglePause() {
    const cur = stateRef.current;
    if (!cur) return;
    if (matchStatus === "paused") {
      void pushEvent("MATCH_RESUMED", cur, { newStatus: "live" });
    } else {
      void pushEvent("MATCH_PAUSED", cur, { newStatus: "paused" });
    }
  }

  function switchServer() {
    const cur = stateRef.current;
    if (!cur || cur.isTiebreak || !cur.servingTeam) return;
    const next = changeServer(cur, cur.servingTeam === "A" ? "B" : "A");
    void pushEvent("SERVER_CHANGED", next);
  }

  function endSet(winnerKey: TeamKey) {
    const cur = stateRef.current;
    if (!cur) return;
    const next = manualEndSet(cur, winnerKey, scoringConfig);
    void pushEvent("MANUAL_SET_END", next, {
      teamId: team(winnerKey).id,
      newStatus: next.matchOver && !confirmFirst ? (navigator.onLine ? "completed" : "pending_sync") : undefined,
    });
    setModal(null);
  }

  function endWith(eventType: string, winnerKey: TeamKey, newStatus: string) {
    const cur = stateRef.current;
    if (!cur) return;
    // Capture any in-progress set so scoreSummary shows real games (e.g. force-end mid-set)
    const extraSet =
      (cur.teamA.games > 0 || cur.teamB.games > 0) &&
      !cur.completedSets.some(
        (s) => s.teamAGames === cur.teamA.games && s.teamBGames === cur.teamB.games
      )
        ? [{ teamAGames: cur.teamA.games, teamBGames: cur.teamB.games }]
        : [];
    const next: ScoreState = {
      ...cur,
      completedSets: [...cur.completedSets, ...extraSet],
      matchOver: true,
      winner: winnerKey,
    };
    void pushEvent(eventType, next, {
      teamId: team(winnerKey).id,
      payload: { winner_team_id: team(winnerKey).id },
      newStatus: navigator.onLine ? newStatus : "pending_sync",
    });
    setModal(null);
  }

  /* ---------------- render helpers ---------------- */
  const statusBadge = useMemo(() => {
    if (!online) return ["Offline — scoring locally", "bg-warning/20 text-warning"];
    if (syncStatus === "error") return ["Sync Error", "bg-danger/20 text-danger"];
    if (syncStatus === "syncing") return ["Syncing…", "bg-accent/20 text-accent"];
    if (pendingCount > 0) return [`Pending Sync (${pendingCount})`, "bg-warning/20 text-warning"];
    return ["Online · Synced", "bg-success/20 text-success"];
  }, [online, syncStatus, pendingCount]);

  function pointLabel(k: TeamKey) {
    if (!state) return "0";
    if (state.isTiebreak) return String(k === "A" ? state.teamA.tiebreakPoints : state.teamB.tiebreakPoints);
    return k === "A" ? state.teamA.points : state.teamB.points;
  }

  if (controller === null) {
    return <div className="flex flex-1 items-center justify-center p-10 text-muted">Connecting…</div>;
  }

  const readOnly = !controller;
  const notStarted = matchStatus === "scheduled" || matchStatus === "ready" || !state;
  const bothCheckedIn = teamA.checkedIn && teamB.checkedIn;

  return (
    <div className="theme-dark mx-auto flex min-h-screen w-full max-w-3xl flex-col bg-background p-3 text-foreground">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
        <div>
          <p className="text-xs text-muted">{tournamentName} · {courtName} · {match.round_name}</p>
          {/* The rules this match resolved to. Stage overrides mean two matches in
              the same tournament can differ, so the referee is told which applies. */}
          <p className="text-[11px] text-muted" data-testid="resolved-rules">{describeMatchRules(scoringConfig)}</p>
          <p className="text-xs font-semibold capitalize">
            {matchStatus.replace("_", " ")}
            {elapsed && !finished && <span className="ml-2 font-mono text-muted">⏱ {elapsed}</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`badge ${statusBadge[1]}`}>{statusBadge[0]}</span>
          <Link href={`/referee/tournaments/${match.tournament_id}/matches`} className="text-xs text-muted hover:text-foreground">
            ← Matches
          </Link>
        </div>
      </div>
      {syncError && (
        <p className="mb-2 rounded-xl bg-danger/15 px-3 py-2 text-xs font-semibold text-danger">
          {syncError}
        </p>
      )}
      {readOnly && !finished && (
        <p className="mb-2 rounded-xl bg-warning/15 px-3 py-2 text-xs font-semibold text-warning">
          Read-only — another device is scoring this match. Ask the admin to release the lock if that device is gone.
        </p>
      )}

      {/* Pre-start */}
      {notStarted && !readOnly ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-5">
          <h1 className="text-center text-2xl font-bold">
            {teamA.name} <span className="text-muted">vs</span> {teamB.name}
          </h1>
          {!bothCheckedIn && !startWarningAck ? (
            <div className="card max-w-sm space-y-3 text-center">
              <p className="font-semibold text-warning">
                ⚠ {!teamA.checkedIn ? teamA.name : ""}
                {!teamA.checkedIn && !teamB.checkedIn ? " and " : ""}
                {!teamB.checkedIn ? teamB.name : ""} {!teamA.checkedIn && !teamB.checkedIn ? "are" : "is"} not checked in.
              </p>
              <p className="text-sm text-muted">Do you still want to start this match?</p>
              <div className="flex gap-2">
                <Link href={`/referee/tournaments/${match.tournament_id}/matches`} className="btn-secondary flex-1 justify-center">
                  Cancel
                </Link>
                <button className="btn-primary flex-1" onClick={() => setStartWarningAck(true)}>
                  Start Anyway
                </button>
              </div>
            </div>
          ) : (
            <div className="w-full max-w-sm space-y-3 text-center">
              <p className="label">Who serves first?</p>
              <div className="grid grid-cols-2 gap-3">
                {(["A", "B"] as TeamKey[]).map((k) => (
                  <button
                    key={k}
                    className="card flex flex-col items-center gap-2 border-2 py-6 hover:border-accent"
                    onClick={() => startMatch(k)}
                  >
                    <span className="text-3xl">🎾</span>
                    <span className="font-bold">{team(k).name}</span>
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted">Tapping a team starts the match with that team serving.</p>
            </div>
          )}
        </div>
      ) : state ? (
        <>
          {/* Scoreboard */}
          <div className="grid grid-cols-2 gap-2">
            {(["A", "B"] as TeamKey[]).map((k) => {
              const info = team(k);
              const ts = k === "A" ? state.teamA : state.teamB;
              const serving = state.servingTeam === k && !state.isTiebreak;
              const isWinner = state.winner === k;
              return (
                <div key={k} className={`card space-y-1 text-center ${isWinner ? "border-success" : ""}`}>
                  <div className="flex items-center justify-center gap-1">
                    {info.players.map((p) => (
                      <Avatar key={p.name} name={p.name} person={p.photo} size={28} />
                    ))}
                  </div>
                  <p className="truncate text-sm font-bold">
                    {serving && <span className="mr-1">🎾</span>}
                    {info.name}
                    {isWinner && " 🏆"}
                  </p>
                  <p className="text-xs text-muted">
                    Sets {ts.sets} · Games {ts.games}
                    {state.completedSets.length > 0 && (
                      <span className="block">{scoreSummary(state)}</span>
                    )}
                  </p>
                  <p key={`${popKey}-${k}`} className="score-pop text-6xl font-bold tabular-nums">
                    {pointLabel(k)}
                  </p>
                </div>
              );
            })}
          </div>
          {state.isTiebreak && !state.matchOver && (
            <p className="mt-1 text-center text-xs font-bold uppercase tracking-widest text-accent">
              Tie-break · first to {scoringConfig.tiebreakTargetPoints}
              {scoringConfig.tiebreakWinByTwo ? ", win by 2" : ""}
            </p>
          )}

          {/* Awaiting confirmation: the score is final, the result is not yet. */}
          {awaitingConfirmation && (
            <div className="card mt-3 space-y-3 border-warning/60 text-center">
              <p className="text-lg font-bold">
                {state.winner ? team(state.winner).name : "Match"} wins {scoreSummary(state) || ""}
              </p>
              <p className="text-sm text-muted">
                Check the score before it goes official. Confirming updates the standings, advances the
                bracket and plays the result on the venue screens.
              </p>
              {!readOnly && (
                <div className="flex gap-2">
                  <button className="btn-secondary flex-1 justify-center" onClick={() => setModal({ kind: "confirm-undo" })}>
                    Undo last point
                  </button>
                  <button className="btn-primary flex-1 justify-center" onClick={confirmResult}>
                    Confirm result
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Finished banner */}
          {!awaitingConfirmation && (finished || state.matchOver) && (
            <div className="card mt-3 border-success/50 text-center">
              <p className="text-lg font-bold text-success">
                🏆 {state.winner ? team(state.winner).name : "Match ended"} wins
              </p>
              <p className="text-sm text-muted">Final score: {scoreSummary(state) || "—"}</p>
              {pendingCount > 0 && (
                <p className="mt-1 text-xs font-semibold text-warning">
                  Result will be official after sync ({pendingCount} pending).
                </p>
              )}
              {!readOnly && (
                <button className="btn-secondary mt-2 text-xs" onClick={() => setModal({ kind: "confirm-undo" })}>
                  Undo (reopen match)
                </button>
              )}
            </div>
          )}

          {/* Score buttons */}
          {!readOnly && !finished && !state.matchOver && (
            <>
              <div className="mt-3 grid flex-1 grid-cols-2 gap-3" style={{ minHeight: "34vh" }}>
                {(["A", "B"] as TeamKey[]).map((k) => (
                  <button
                    key={k}
                    onClick={() => tapScore(k)}
                    disabled={matchStatus === "paused"}
                    className="rounded-[20px] border-2 border-accent/50 bg-accent/10 text-xl font-bold transition active:scale-95 active:bg-accent/30 disabled:opacity-40"
                  >
                    + Point
                    <span className="block text-sm font-semibold text-muted">{team(k).name}</span>
                  </button>
                ))}
              </div>

              {/* Controls */}
              <div className="mt-3 grid grid-cols-3 gap-2 pb-2">
                <button
                  className="btn-secondary py-3"
                  onClick={() => setModal({ kind: "confirm-undo" })}
                  disabled={history.length === 0}
                >
                  ↩ Undo
                </button>
                <button className="btn-secondary py-3" onClick={togglePause}>
                  {matchStatus === "paused" ? "▶ Resume" : "⏸ Pause"}
                </button>
                <button
                  className="btn-secondary py-3"
                  onClick={switchServer}
                  disabled={state.isTiebreak}
                  title={state.isTiebreak ? "Server hidden during tie-break" : "Change serving team"}
                >
                  🎾 Server
                </button>
                <button className="btn-secondary py-3" onClick={() => setModal({ kind: "end-set", team: null })}>
                  End set
                </button>
                <button className="btn-danger col-span-2 py-3" onClick={() => setModal({ kind: "end-menu" })}>
                  End match…
                </button>
              </div>
            </>
          )}
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center text-muted">Waiting for match to start…</div>
      )}

      {/* ------------- Modals ------------- */}
      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="card w-full max-w-sm space-y-3 bg-card">
            {modal.kind === "confirm-point" && state && (
              <>
                <h3 className="font-bold">{modal.message}</h3>
                <p className="text-sm text-muted">
                  Current point score: {pointLabel("A")} - {pointLabel("B")} · Games:{" "}
                  {state.teamA.games}-{state.teamB.games}
                </p>
                <div className="flex gap-2">
                  <button className="btn-secondary flex-1" onClick={() => setModal(null)}>Cancel</button>
                  <button className="btn-primary flex-1" onClick={() => applyPoint(modal.team)}>Confirm</button>
                </div>
              </>
            )}
            {modal.kind === "confirm-undo" && (
              <>
                <h3 className="font-bold">Undo last scoring action?</h3>
                <p className="text-sm text-muted">
                  This will revert the last point/game action and save an undo record.
                </p>
                <div className="flex gap-2">
                  <button className="btn-secondary flex-1" onClick={() => setModal(null)}>Cancel</button>
                  <button className="btn-danger flex-1" onClick={doUndo}>Confirm Undo</button>
                </div>
              </>
            )}
            {modal.kind === "end-menu" && (
              <>
                <h3 className="font-bold">End match</h3>
                <div className="space-y-2">
                  <button className="btn-secondary w-full" onClick={() => setModal({ kind: "force-end", winner: null })}>
                    Force end with current score
                  </button>
                  <button className="btn-secondary w-full" onClick={() => setModal({ kind: "walkover", absent: null })}>
                    Walkover (team didn&apos;t show)
                  </button>
                  <button className="btn-secondary w-full" onClick={() => setModal({ kind: "retire", team: null })}>
                    Retirement / injury
                  </button>
                  <button className="btn-secondary w-full text-danger" onClick={() => setModal({ kind: "disqualify", team: null })}>
                    Disqualification
                  </button>
                </div>
                <button className="btn-secondary w-full" onClick={() => setModal(null)}>Cancel</button>
              </>
            )}
            {modal.kind === "force-end" && state && (
              <>
                <h3 className="font-bold">You are about to end this match manually.</h3>
                <p className="text-sm text-muted">
                  Current score: {teamA.name} {state.teamA.games} games · {teamB.name} {state.teamB.games} games.
                  Select the winner — the match is saved with the current score.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {(["A", "B"] as TeamKey[]).map((k) => (
                    <button
                      key={k}
                      className={modal.winner === k ? "btn-primary" : "btn-secondary"}
                      onClick={() => setModal({ kind: "force-end", winner: k })}
                    >
                      {team(k).name}
                    </button>
                  ))}
                </div>
                <div className="flex gap-2">
                  <button className="btn-secondary flex-1" onClick={() => setModal(null)}>Cancel</button>
                  <button
                    className="btn-danger flex-1"
                    disabled={!modal.winner}
                    onClick={() => modal.winner && endWith("FORCE_END", modal.winner, "completed")}
                  >
                    Confirm End Match
                  </button>
                </div>
              </>
            )}
            {modal.kind === "walkover" && (
              <>
                <h3 className="font-bold">Walkover — which team did NOT show up?</h3>
                <div className="grid grid-cols-2 gap-2">
                  {(["A", "B"] as TeamKey[]).map((k) => (
                    <button
                      key={k}
                      className={modal.absent === k ? "btn-primary" : "btn-secondary"}
                      onClick={() => setModal({ kind: "walkover", absent: k })}
                    >
                      {team(k).name}
                    </button>
                  ))}
                </div>
                {modal.absent && (
                  <p className="text-sm text-muted">
                    {team(modal.absent === "A" ? "B" : "A").name} wins by walkover ({scoringConfig.walkoverScore}).
                  </p>
                )}
                <div className="flex gap-2">
                  <button className="btn-secondary flex-1" onClick={() => setModal(null)}>Cancel</button>
                  <button
                    className="btn-danger flex-1"
                    disabled={!modal.absent}
                    onClick={() => modal.absent && endWith("WALKOVER", modal.absent === "A" ? "B" : "A", "walkover")}
                  >
                    Confirm Walkover
                  </button>
                </div>
              </>
            )}
            {modal.kind === "disqualify" && (
              <>
                <h3 className="font-bold">Disqualify which team?</h3>
                <div className="grid grid-cols-2 gap-2">
                  {(["A", "B"] as TeamKey[]).map((k) => (
                    <button
                      key={k}
                      className={modal.team === k ? "btn-danger" : "btn-secondary"}
                      onClick={() => setModal({ kind: "disqualify", team: k })}
                    >
                      {team(k).name}
                    </button>
                  ))}
                </div>
                {modal.team && (
                  <p className="text-sm text-muted">{team(modal.team === "A" ? "B" : "A").name} wins this match.</p>
                )}
                <div className="flex gap-2">
                  <button className="btn-secondary flex-1" onClick={() => setModal(null)}>Cancel</button>
                  <button
                    className="btn-danger flex-1"
                    disabled={!modal.team}
                    onClick={() => modal.team && endWith("DISQUALIFICATION", modal.team === "A" ? "B" : "A", "disqualified")}
                  >
                    Confirm Disqualification
                  </button>
                </div>
              </>
            )}
            {modal.kind === "retire" && (
              <>
                <h3 className="font-bold">Which team retires (injury)?</h3>
                <div className="grid grid-cols-2 gap-2">
                  {(["A", "B"] as TeamKey[]).map((k) => (
                    <button
                      key={k}
                      className={modal.team === k ? "btn-primary" : "btn-secondary"}
                      onClick={() => setModal({ kind: "retire", team: k })}
                    >
                      {team(k).name}
                    </button>
                  ))}
                </div>
                {modal.team && (
                  <p className="text-sm text-muted">
                    {team(modal.team === "A" ? "B" : "A").name} wins. Current score is kept.
                  </p>
                )}
                <div className="flex gap-2">
                  <button className="btn-secondary flex-1" onClick={() => setModal(null)}>Cancel</button>
                  <button
                    className="btn-danger flex-1"
                    disabled={!modal.team}
                    onClick={() => modal.team && endWith("RETIREMENT", modal.team === "A" ? "B" : "A", "retired")}
                  >
                    Confirm Retirement
                  </button>
                </div>
              </>
            )}
            {modal.kind === "end-set" && state && (
              <>
                <h3 className="font-bold">Manually end this set — who wins it?</h3>
                <p className="text-sm text-muted">
                  Current games: {teamA.name} {state.teamA.games} - {state.teamB.games} {teamB.name}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {(["A", "B"] as TeamKey[]).map((k) => (
                    <button key={k} className="btn-primary" onClick={() => endSet(k)}>
                      {team(k).name}
                    </button>
                  ))}
                </div>
                <button className="btn-secondary w-full" onClick={() => setModal(null)}>Cancel</button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

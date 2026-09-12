"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { EntityTable } from "dexie";
import {
  applyMove,
  currentGame,
  declareDraw,
  decideWinner,
  formatMovePairs,
  inCheck,
  matchScoreSummary,
  newChessState,
  resign,
  sideToMove,
  type ChessState,
  type Side,
} from "@/lib/chess/engine";
import type { Match, MatchSnapshot } from "@/lib/types";
import { offlineDb, getDeviceId } from "@/lib/offline/db";
import ChessBoard from "@/components/ChessBoard";

interface TeamInfo {
  id: string;
  name: string;
  players: { name: string; photo: string | null }[];
}

interface ChessLocalEvent {
  client_event_id: string;
  match_id: string;
  event_number: number;
  event_type: string;
  team_id: string | null;
  previous_state: ChessState | null;
  new_state: ChessState;
  payload: Record<string, unknown> | null;
  created_at_client: string;
  sync_status: "pending" | "synced";
}
interface ChessLocalMatchState {
  match_id: string;
  state: ChessState;
  history: ChessState[];
  last_event_number: number;
  match_status: string;
  updated_at: string;
}

// The offline tables are shared with padel; cast for chess-typed access.
const eventsTable = offlineDb.events as unknown as EntityTable<ChessLocalEvent, "client_event_id">;
const stateTable = offlineDb.matchState as unknown as EntityTable<ChessLocalMatchState, "match_id">;

const FINISHED = ["completed", "walkover", "disqualified", "retired", "cancelled"];

export default function ChessScoreClient({
  match,
  tournamentName,
  boardName,
  legs,
  teamA,
  teamB,
  serverSnapshot,
}: {
  match: Match;
  tournamentName: string;
  boardName: string;
  legs: 1 | 2;
  teamA: TeamInfo;
  teamB: TeamInfo;
  serverSnapshot: MatchSnapshot | null;
}) {
  const [state, setState] = useState<ChessState | null>(null);
  const [history, setHistory] = useState<ChessState[]>([]);
  const [matchStatus, setMatchStatus] = useState(match.status);
  const [controller, setController] = useState<boolean | null>(null);
  const [online, setOnline] = useState(true);
  const [syncStatus, setSyncStatus] = useState<"synced" | "syncing" | "pending" | "error">("synced");
  const [syncError, setSyncError] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);

  const eventNumberRef = useRef(serverSnapshot?.last_event_number ?? 0);
  const syncingRef = useRef(false);
  const deviceIdRef = useRef<string>("");
  const stateRef = useRef<ChessState | null>(null);
  const historyRef = useRef<ChessState[]>([]);

  const commit = useCallback((next: ChessState | null, nextHistory: ChessState[]) => {
    stateRef.current = next;
    historyRef.current = nextHistory;
    setState(next);
    setHistory(nextHistory);
  }, []);

  const finished = FINISHED.includes(matchStatus);
  const team = useCallback((k: Side) => (k === "A" ? teamA : teamB), [teamA, teamB]);

  /* ---------------- sync loop (identical contract to padel) ---------------- */
  const trySync = useCallback(async () => {
    if (syncingRef.current || !navigator.onLine) return;
    const pending = await eventsTable
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
        await eventsTable.bulkPut(pending.map((e) => ({ ...e, sync_status: "synced" as const })));
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
    }
  }, [match.id]);

  useEffect(() => {
    const id = setInterval(() => void trySync(), 6000);
    return () => clearInterval(id);
  }, [trySync]);

  /* ---------------- init: restore + claim lock ---------------- */
  useEffect(() => {
    deviceIdRef.current = getDeviceId();
    async function init() {
      setOnline(navigator.onLine);
      const local = await stateTable.get(match.id);
      const serverState = (serverSnapshot?.snapshot_json as ChessState | null) ?? null;
      const serverEventNo = serverSnapshot?.last_event_number ?? 0;

      if (local && local.last_event_number >= serverEventNo) {
        commit(local.state, local.history);
        eventNumberRef.current = local.last_event_number;
        if (!FINISHED.includes(match.status)) setMatchStatus(local.match_status as Match["status"]);
      } else if (serverState && serverState.games) {
        commit(serverState, []);
      }
      const pend = await eventsTable
        .where("match_id").equals(match.id)
        .and((e) => e.sync_status === "pending")
        .count();
      setPendingCount(pend);
      if (pend > 0) setSyncStatus("pending");

      if (FINISHED.includes(match.status)) {
        setController(false);
        return;
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

  /* ---------------- event creation ---------------- */
  const pushEvent = useCallback(
    async (
      eventType: string,
      newState: ChessState,
      opts: { teamId?: string | null; payload?: Record<string, unknown>; newStatus?: string; isUndo?: boolean } = {}
    ) => {
      const prev = stateRef.current;
      const n = ++eventNumberRef.current;
      const event: ChessLocalEvent = {
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
        opts.isUndo
          ? historyRef.current.slice(0, -1)
          : prev
            ? [...historyRef.current, prev]
            : historyRef.current
      ).slice(-200);
      commit(newState, nextHistory);
      if (opts.newStatus) setMatchStatus(opts.newStatus as Match["status"]);
      setPendingCount((c) => c + 1);
      setSyncStatus(navigator.onLine ? "syncing" : "pending");
      await eventsTable.put(event);
      await stateTable.put({
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
  function startMatch() {
    const s = newChessState(legs);
    void pushEvent("MATCH_STARTED", s, { newStatus: "live", payload: { legs } });
  }

  function terminalOpts(next: ChessState) {
    // When the whole match is decided, complete it; otherwise stay live.
    if (next.matchOver && next.winner) {
      return {
        teamId: team(next.winner).id,
        payload: { winner_team_id: team(next.winner).id },
        newStatus: navigator.onLine ? "completed" : "pending_sync",
      };
    }
    return {};
  }

  function onMove(from: string, to: string, promotion?: "q" | "r" | "b" | "n") {
    const cur = stateRef.current;
    if (!cur || finished || cur.matchOver) return;
    const { state: next, san } = applyMove(cur, from, to, promotion);
    if (!san) return; // illegal
    setLastMove({ from, to });
    void pushEvent("MOVE_MADE", next, { payload: { san, from, to }, ...terminalOpts(next) });
  }

  function doResign(side: Side) {
    const cur = stateRef.current;
    if (!cur || cur.matchOver) return;
    const next = resign(cur, side);
    void pushEvent("RESIGN", next, { payload: { resigned: side }, ...terminalOpts(next) });
  }

  function doDraw() {
    const cur = stateRef.current;
    if (!cur || cur.matchOver) return;
    const next = declareDraw(cur);
    void pushEvent("DRAW_DECLARED", next, terminalOpts(next));
  }

  function doDecide(side: Side) {
    const cur = stateRef.current;
    if (!cur) return;
    const next = decideWinner(cur, side);
    void pushEvent("MATCH_ENDED", next, {
      teamId: team(side).id,
      payload: { winner_team_id: team(side).id, arbiter: true },
      newStatus: navigator.onLine ? "completed" : "pending_sync",
    });
  }

  function doUndo() {
    if (historyRef.current.length === 0) return;
    const prev = historyRef.current[historyRef.current.length - 1];
    setLastMove(null);
    void pushEvent("UNDO", prev, { isUndo: true, newStatus: finished ? "live" : undefined });
  }

  /* ---------------- render ---------------- */
  const statusBadge = useMemo(() => {
    if (!online) return ["Offline — saving locally", "bg-warning/20 text-warning"];
    if (syncStatus === "error") return ["Sync Error", "bg-danger/20 text-danger"];
    if (syncStatus === "syncing") return ["Syncing…", "bg-accent/20 text-accent"];
    if (pendingCount > 0) return [`Pending Sync (${pendingCount})`, "bg-warning/20 text-warning"];
    return ["Online · Synced", "bg-success/20 text-success"];
  }, [online, syncStatus, pendingCount]);

  if (controller === null) {
    return <div className="flex flex-1 items-center justify-center p-10 text-muted">Connecting…</div>;
  }

  const readOnly = !controller;
  const notStarted = (matchStatus === "scheduled" || matchStatus === "ready" || !state) && !finished;
  const g = state ? currentGame(state) : null;
  const whiteName = g ? team(g.whiteSide).name : teamA.name;
  const blackName = g ? team(g.whiteSide === "A" ? "B" : "A").name : teamB.name;
  const toMove = state && !state.matchOver && g && !g.result ? sideToMove(state) : null;
  const boardInteractive = Boolean(state) && !readOnly && !finished && !state!.matchOver && !!g && !g.result;
  const movePairs = g ? formatMovePairs(g.sanHistory) : [];
  const lastPairs = movePairs.slice(-6);

  return (
    <div className="theme-dark mx-auto flex min-h-screen w-full max-w-md flex-col bg-background p-3 text-foreground">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
        <div>
          <p className="text-xs text-muted">{tournamentName} · {boardName} · {match.round_name}</p>
          <p className="text-xs font-semibold capitalize">
            ♟ Chess{legs === 2 ? ` · 2-game match` : ""} · {matchStatus.replace("_", " ")}
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
        <p className="mb-2 rounded-xl bg-danger/15 px-3 py-2 text-xs font-semibold text-danger">{syncError}</p>
      )}
      {readOnly && !finished && (
        <p className="mb-2 rounded-xl bg-warning/15 px-3 py-2 text-xs font-semibold text-warning">
          Read-only — another device is recording this game.
        </p>
      )}

      {notStarted && !readOnly ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-5">
          <h1 className="text-center text-2xl font-bold">
            {teamA.name} <span className="text-muted">vs</span> {teamB.name}
          </h1>
          <p className="text-sm text-muted">
            {teamA.name} plays White in game 1{legs === 2 ? "; colours reverse in game 2." : "."}
          </p>
          <button className="btn-primary px-8 py-3" onClick={startMatch}>Start game</button>
        </div>
      ) : state && g ? (
        <>
          {/* Players */}
          <div className="grid grid-cols-2 gap-2">
            {([["white", whiteName, "#fff", "#111"], ["black", blackName, "#111", "#fff"]] as const).map(
              ([color, name]) => {
                const isToMove = toMove !== null && team(toMove).name === name;
                const isWinner = state.matchOver && state.winner !== null && team(state.winner).name === name;
                return (
                  <div key={color} className={`card space-y-1 text-center ${isWinner ? "border-success" : ""}`}>
                    <p className="text-[10px] uppercase tracking-widest text-muted">
                      {color === "white" ? "○ White" : "● Black"}
                    </p>
                    <p className="truncate text-sm font-bold">
                      {isToMove && <span className="mr-1 text-accent">▸</span>}
                      {name}
                      {isWinner && " 🏆"}
                    </p>
                  </div>
                );
              }
            )}
          </div>

          {/* Board */}
          <div className="mx-auto mt-3 w-full max-w-sm">
            <ChessBoard
              fen={g.fen}
              onMove={boardInteractive ? onMove : undefined}
              readOnly={!boardInteractive}
              showCoords
              lastMove={lastMove}
            />
          </div>

          {toMove && (
            <p className="mt-2 text-center text-xs font-semibold text-muted">
              {team(toMove).name} to move{inCheck(state) ? " · CHECK" : ""}
            </p>
          )}

          {/* Move log */}
          <div className="mt-2 rounded-xl bg-card p-2">
            <p className="mb-1 text-[10px] uppercase tracking-widest text-muted">Moves (game {state.currentGameIndex + 1}{legs === 2 ? `/${legs}` : ""})</p>
            <p className="min-h-5 break-words font-mono text-xs leading-relaxed">
              {lastPairs.length > 0 ? lastPairs.join("   ") : <span className="text-muted">No moves yet</span>}
            </p>
          </div>

          {/* Arbiter decision */}
          {state.needsArbiter && !state.matchOver && !readOnly && (
            <div className="card mt-3 border-warning/50 text-center">
              <p className="text-sm font-bold text-warning">
                {legs === 2 ? "Match tied " : "Game drawn "}
                {matchScoreSummary(state)} — arbiter decides who advances:
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {(["A", "B"] as Side[]).map((k) => (
                  <button key={k} className="btn-primary" onClick={() => doDecide(k)}>{team(k).name}</button>
                ))}
              </div>
            </div>
          )}

          {/* Finished banner */}
          {(finished || state.matchOver) && state.winner && (
            <div className="card mt-3 border-success/50 text-center">
              <p className="text-lg font-bold text-success">🏆 {team(state.winner).name} advances</p>
              {matchScoreSummary(state) && (
                <p className="text-sm text-muted">Match score: {matchScoreSummary(state)}</p>
              )}
              {pendingCount > 0 && (
                <p className="mt-1 text-xs font-semibold text-warning">Official after sync ({pendingCount} pending).</p>
              )}
              {!readOnly && (
                <button className="btn-secondary mt-2 text-xs" onClick={doUndo} disabled={history.length === 0}>
                  Undo (reopen)
                </button>
              )}
            </div>
          )}

          {/* Controls */}
          {!readOnly && !finished && !state.matchOver && g && !g.result && (
            <div className="mt-3 grid grid-cols-2 gap-2 pb-2">
              <button className="btn-secondary py-3" onClick={doUndo} disabled={history.length === 0}>↩ Undo</button>
              <button className="btn-secondary py-3" onClick={doDraw}>½ Draw</button>
              <button className="btn-danger py-3" onClick={() => doResign(g.whiteSide)}>Resign · White</button>
              <button className="btn-danger py-3" onClick={() => doResign(g.whiteSide === "A" ? "B" : "A")}>Resign · Black</button>
            </div>
          )}
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center text-muted">Waiting for game to start…</div>
      )}
    </div>
  );
}

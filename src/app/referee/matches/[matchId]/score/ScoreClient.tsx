"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  changeServer,
  currentServer,
  endsChange,
  initialScoreState,
  manualEndSet,
  pointOutcome,
  scoreSummary,
  servingPlayer,
  swapDoublesServer,
  type EndsChange,
  type ScoreState,
  type TeamKey,
} from "@/lib/scoring/engine";
import { OFFENCE_LABELS, PENALTY_LABELS, nextPenalty, type Offence } from "@/lib/scoring/conduct";
import type { MatchSnapshot, Match, PhotoFields, ScoringConfig } from "@/lib/types";
import { offlineDb, getDeviceId, type LocalScoreEvent } from "@/lib/offline/db";
import { describeMatchRules } from "@/lib/scoring/rules";
import VoicePanel from "./VoicePanel";
import ControlPanel from "./ControlPanel";
import { useScoringControl } from "./useScoringControl";
import { useUmpireVoice } from "./useUmpireVoice";
import { SIDES, sideTint } from "@/lib/sides";
import FinalScoreEntry from "@/components/scoring/FinalScoreEntry";
import CallCard from "@/components/scoring/CallCard";
import type { CallSnapshot } from "@/lib/matchday/callCard";
import type { MatchDayRules } from "@/lib/matchday/rules";
import { enteredSetsFromState } from "@/lib/scoring/finalScore";
import { RESULT_ENTERED, finalResultAllowed, type ResultPayload, type ResultProblem } from "@/lib/scoring/resultEntry";
import { queueableResult, resultPayloadOf, resultRejection } from "@/lib/offline/finalResult";
import type { ScoringModeChoice } from "@/lib/matchday/rules";
import { useSunlight } from "@/components/referee/useSunlight";
import * as C from "@/lib/scoring/console";
import { pushesHistory } from "@/lib/scoring/eventGuard";
import { aceMoment, defaultServeOrder, lockServeOrder, needsServeOrder, tossDecidesServer, type ServeOrder } from "@/lib/scoring/serve";
import { TIMERS, sidesSwapped, withoutClock, type TimeDecision, type TimerKind } from "@/lib/scoring/timing";
import { aceCounts } from "@/lib/scoring/matchLog";
import { nationByCode } from "@/lib/tennis/nations";
import { SCORING_FEATURES_OFF } from "@/lib/matchday/rules";
import { BetweenPointsBanner, BoardV2, MatchLogPanel, PadV2, ServeOrderDialog, TimerCard, shortCode, useNow, type RunningTimer, type V2Side } from "./V2";

/** "RED TEAM" / "BLUE TEAM" in its colour, when the organiser uses red and blue teams. */
function SideChip({ side }: { side: TeamKey }) {
  return (
    <span
      className="inline-block rounded-md px-2 py-0.5 text-[11px] font-black uppercase tracking-widest text-white"
      style={{ background: SIDES[side].hex }}
      data-testid={`side-chip-${side}`}
    >
      {SIDES[side].label}
    </span>
  );
}

interface TeamInfo {
  id: string;
  name: string;
  players: { name: string; photo: PhotoFields }[];
  checkedIn: boolean;
  /** A rubber of a nations tie: the side's ITF code, so the voice names it ("Game, Romania."). */
  nation?: string | null;
}

type Modal =
  | { kind: "confirm-point"; team: TeamKey; message: string; action?: "point" | "ace" | "fault" }
  | { kind: "let" }
  | { kind: "more" }
  | { kind: "call" }
  | { kind: "log" }
  | { kind: "break-team"; timer: TimerKind }
  | { kind: "time-team"; decision: TimeDecision; timer: TimerKind; seconds: number }
  | { kind: "confirm-undo" }
  | { kind: "end-menu" }
  | { kind: "force-end"; winner: TeamKey | null }
  | { kind: "walkover"; absent: TeamKey | null }
  | { kind: "disqualify"; team: TeamKey | null }
  | { kind: "retire"; team: TeamKey | null }
  | { kind: "end-set"; team: TeamKey | null }
  | { kind: "voice" }
  | { kind: "violation"; team: TeamKey | null; offence: Offence }
  | { kind: "final-result"; correcting: boolean; initial: ResultPayload | null }
  | null;

/** The server's (or the queue's) answer to a final result, shown in the entry form. */
interface ResultError {
  message: string;
  problems: ResultProblem[];
}

/** A changeover or set break the referee is timing. */
interface RestClock {
  kind: NonNullable<EndsChange["kind"]>;
  changeEnds: boolean;
  endsAt: number;
}

const FINISHED = ["completed", "walkover", "disqualified", "retired", "cancelled"];

/** The time now, for the referee's taps (timers start and stop on a tap, never during render). */
const wallClock = () => Date.now();

export default function ScoreClient({
  match,
  tournamentName,
  courtName,
  scoringConfig,
  teamA,
  teamB,
  serverSnapshot,
  reopenState = null,
  redBlueTeams = false,
  tennis = false,
  scoringMode = "point_by_point",
  matchDay = null,
  initialCall = null,
  canCorrect = false,
  assistance = null,
  callMaster = false,
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
  /** The organiser's red-and-blue-teams setting: team A is Red, team B Blue. */
  redBlueTeams?: boolean;
  /** Tennis: changeover clock, serving player in doubles, code violations. */
  tennis?: boolean;
  /** How this match is recorded (match override → session → match-day rules). */
  scoringMode?: ScoringModeChoice;
  /** The tournament's match-day rules (court call, no-show prompt). */
  matchDay?: MatchDayRules | null;
  /** The match's call to court when the page loaded. */
  initialCall?: CallSnapshot | null;
  /** The organiser's staff (admin, manager) correct a finished result; a referee does not (append.ts correctionCut). */
  canCorrect?: boolean;
  /** A court referee's "Call for assistance" (migration 0035), under the header. */
  assistance?: React.ReactNode;
  /** Scoring v2: More → "Call master referee" (a court referee signed in with a PIN, the organiser's switch on). */
  callMaster?: boolean;
}) {
  // Follows the device's light/dark setting (the referee layout); "☀ Sunlight" is the high-contrast light extra.
  const [sunlight, setSunlight] = useSunlight();
  const [state, setState] = useState<ScoreState | null>(null);
  const [history, setHistory] = useState<ScoreState[]>([]);
  const [matchStatus, setMatchStatus] = useState(match.status);
  const [online, setOnline] = useState(true);
  const [syncStatus, setSyncStatus] = useState<"synced" | "syncing" | "pending" | "error">("synced");
  const [syncError, setSyncError] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [elapsed, setElapsed] = useState("");
  const [startWarningAck, setStartWarningAck] = useState(false);
  const [rest, setRest] = useState<RestClock | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Only the device holding the match speaks; a read-only page stays quiet.
  // Starts from the page load and follows the organiser's setting on every sync.
  const [redBlue, setRedBlue] = useState(redBlueTeams);
  const [resultError, setResultError] = useState<ResultError | null>(null);
  const [resultBusy, setResultBusy] = useState(false);
  const resultAllowed = finalResultAllowed(scoringMode);

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

  // A finished, non-reopenable match has nothing left to control: no claim is
  // made and the panel never polls. See getReopenState — only a completed
  // match with a recorded pre-winning-point state can be reopened, and never
  // one ended by cancellation.
  const controlDisabled = FINISHED.includes(match.status) && (!reopenState || match.status === "cancelled");
  const control = useScoringControl(match.id, {
    initialMatch: match,
    initialSnapshot: serverSnapshot,
    disabled: controlDisabled,
  });
  const voice = useUmpireVoice(
    scoringConfig,
    control.isController,
    redBlue,
    tennis ? { nations: { A: teamA.nation ?? null, B: teamB.nation ?? null } } : null,
  );
  const onVoiceEvent = voice.onEvent;

  const readOnly = !control.isController;
  // What this device currently shows. A controller's own state is already
  // live — every tap applies straight to it. A read-only device has no taps
  // of its own, so it shows the freshest polled snapshot instead:
  // match_score_snapshots.snapshot_json is the very same ScoreState shape
  // `state` already is (see page.tsx's own server-side commit). Computed here
  // during render rather than synced in via an effect — the lint rule (and
  // React's own guidance) is explicit that a value already available from
  // another hook belongs in a derived const, not an effect that mirrors it.
  const renderState: ScoreState | null = readOnly ? ((control.snapshot?.snapshot_json as ScoreState | null) ?? state) : state;
  const renderStatus: Match["status"] = readOnly ? (control.match?.status ?? matchStatus) : matchStatus;
  const renderFinished = FINISHED.includes(renderStatus);

  const finished = FINISHED.includes(matchStatus);
  const confirmFirst = scoringConfig.requireResultConfirmation === true;
  // The score says the match is over, but nobody has confirmed it yet.
  const awaitingConfirmation = confirmFirst && Boolean(renderState?.matchOver) && !renderFinished;
  const team = useCallback((k: TeamKey) => (k === "A" ? teamA : teamB), [teamA, teamB]);
  // Doubles in tennis: which player serves is tracked, not just which team.
  const doubles = tennis && teamA.players.length >= 2 && teamB.players.length >= 2;
  /* ---------------- scoring v2 ---------------- */
  // The organiser's switches (Admin → Scoring features); all off for a tournament that never set them.
  const features = matchDay?.features ?? SCORING_FEATURES_OFF;
  // Serve and receive order by player: every doubles match (padel too).
  const pairs = teamA.players.length >= 2 && teamB.players.length >= 2;
  const [timer, setTimer] = useState<RunningTimer | null>(null);
  const timerRef = useRef<RunningTimer | null>(null);
  const putTimer = useCallback((t: RunningTimer | null) => {
    timerRef.current = t;
    setTimer(t);
  }, []);
  const [manualSwap, setManualSwap] = useState(false);
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setManualSwap(localStorage.getItem(`ms.swap.${match.id}`) === "1");
    } catch {
      /* storage blocked */
    }
  }, [match.id]);
  const toggleSwap = () => {
    const v = !manualSwap;
    setManualSwap(v);
    try {
      localStorage.setItem(`ms.swap.${match.id}`, v ? "1" : "0");
    } catch {
      /* storage blocked */
    }
  };
  const [callNote, setCallNote] = useState<string | null>(null);
  const tick = useNow(Boolean(timer));
  // A recorded timer still running in the score (this console reloaded, or took the match over).
  useEffect(() => {
    if (timerRef.current || !state || state.matchOver) return;
    const running = C.runningClock(state);
    const started = running ? Date.parse(running.startedAt) : NaN;
    if (running && Number.isFinite(started) && Date.now() - started < 30 * 60_000) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      putTimer({ kind: running.kind, startedAt: started, team: running.team, recorded: true });
    }
  }, [state, putTimer]);

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
        const synced = (await res.json().catch(() => null)) as { red_blue_teams?: unknown } | null;
        if (typeof synced?.red_blue_teams === "boolean") setRedBlue(synced.red_blue_teams);
        await offlineDb.events.bulkPut(pending.map((e) => ({ ...e, sync_status: "synced" as const })));
        setPendingCount(0);
        setSyncStatus("synced");
        setSyncError(null);
      } else if (res.status === 400 || res.status === 409) {
        const data = await res.json().catch(() => ({}));
        // A final result the server refused never blocks the match: it leaves the
        // queue (with anything queued after it), the score goes back to before it,
        // and the referee enters it again.
        const rejected = resultRejection(pending, res.status, data);
        if (rejected) {
          await offlineDb.events.bulkDelete(rejected.drop.map((e) => e.client_event_id));
          const restore = (rejected.restore as ScoreState | null) ?? null;
          let nextHistory = historyRef.current;
          for (const e of [...rejected.drop].reverse()) if (pushesHistory(e.event_type)) nextHistory = nextHistory.slice(0, -1);
          commit(restore, nextHistory);
          eventNumberRef.current = rejected.lastEventNumber;
          const status = (restore ? "live" : match.status) as Match["status"];
          setMatchStatus(status);
          if (restore) {
            await offlineDb.matchState.put({
              match_id: match.id,
              state: restore,
              history: nextHistory,
              last_event_number: rejected.lastEventNumber,
              match_status: status,
              updated_at: new Date().toISOString(),
            });
          } else {
            await offlineDb.matchState.delete(match.id);
          }
          const left = pending.length - rejected.drop.length;
          setPendingCount(left);
          setSyncStatus(left > 0 ? "pending" : "synced");
          setSyncError(null);
          setResultError({ message: `Result not recorded: ${rejected.message}`, problems: rejected.problems });
          setModal({ kind: "final-result", correcting: false, initial: resultPayloadOf(rejected.result) });
          if (left > 0) resyncRef.current = true;
        } else if (res.status === 409) {
          setSyncStatus("error");
          setSyncError((data as { error?: string }).error ?? "Sync conflict — contact the tournament manager.");
        } else {
          setSyncStatus("error");
          setSyncError((data as { error?: string }).error ?? "The server refused this score.");
        }
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
  }, [match.id, match.status, commit]);

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

      // A finished match is read-only unless it can be reopened. Finalising
      // ends its lease, so any referee device may take it to undo the winning
      // point — the confirming tablet may be flat, or reloaded. `controlDisabled`
      // (passed to useScoringControl) already covers the non-reopenable case —
      // its hook never polls or claims, so nothing further is needed here.
      if (!controlDisabled) {
        if (FINISHED.includes(match.status) && reopenState && historyRef.current.length === 0) {
          commit(stateRef.current, [reopenState]);
        }
        // Offline right now: lean on local state, the strongest signal this
        // device — not some other one — was the one scoring the match.
        await control.claim(Boolean(local));
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

  /* ---------------- taking over: carry on from the server's score ---------------- */
  // The score above loads once. A device that becomes the scorer later (an
  // accepted handover, "Take control") would otherwise number its next point
  // from that old score and be refused forever. With nothing of its own to
  // send, it carries on from the server's latest score instead.
  const wasControllerRef = useRef(false);
  const pendingOnDevice = useCallback(
    () => offlineDb.events.where("match_id").equals(match.id).and((e) => e.sync_status === "pending").count(),
    [match.id],
  );
  useEffect(() => {
    const became = control.isController && !wasControllerRef.current;
    wasControllerRef.current = control.isController;
    if (!became) return;
    const at = eventNumberRef.current;
    void (async () => {
      try {
        if ((await pendingOnDevice()) > 0) return;
        const res = await fetch(`/api/matches/${match.id}/state`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { match: Match; snapshot: MatchSnapshot | null };
        const n = data.snapshot?.last_event_number ?? 0;
        // A tap since this started has its own number already: leave it be.
        if (eventNumberRef.current !== at || n <= at || !data.snapshot?.snapshot_json) return;
        commit(data.snapshot.snapshot_json as ScoreState, []);
        eventNumberRef.current = n;
        setMatchStatus(data.match.status);
      } catch {
        // Offline: keep the score this device has.
      }
    })();
  }, [control.isController, match.id, commit, pendingOnDevice]);

  // A handover or release waits until every point on this device is sent;
  // otherwise the next device starts without them.
  const guardedControl = useMemo(
    () => ({
      ...control,
      respond: async (accept: boolean) => {
        if (accept) {
          const left = await pendingOnDevice();
          if (left > 0) {
            setPendingCount(left);
            void trySync();
            return;
          }
        }
        await control.respond(accept);
      },
      release: async () => {
        const left = await pendingOnDevice();
        if (left > 0) {
          setPendingCount(left);
          void trySync();
          return;
        }
        await control.release();
      },
    }),
    [control, pendingOnDevice, trySync],
  );

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

  /* ---------------- tennis: changeovers ---------------- */
  useEffect(() => {
    if (!rest) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [rest]);

  // The umpire calls "Time" when the rest runs out, unless play has already moved on.
  const sayVoice = voice.say;
  useEffect(() => {
    if (!tennis || !rest) return;
    const wait = rest.endsAt - Date.now();
    if (wait <= 0) return;
    const at = eventNumberRef.current;
    const id = setTimeout(() => {
      if (eventNumberRef.current === at) sayVoice(["time"]);
    }, wait);
    return () => clearTimeout(id);
  }, [tennis, rest, sayVoice]);

  /** After a point or penalty: tell the referee when the players change ends and time the rest. */
  const noteEnds = useCallback(
    (prev: ScoreState | null, next: ScoreState) => {
      if (!tennis || !prev) return;
      const change = endsChange(prev, next);
      if (!change.kind) {
        // Play has moved on: a finished rest (or a change with none) is cleared.
        setRest((r) => (r && r.endsAt > Date.now() ? r : null));
        return;
      }
      const t = Date.now();
      setNow(t);
      setRest({ kind: change.kind, changeEnds: change.changeEnds, endsAt: t + change.restSeconds * 1000 });
    },
    [tennis],
  );

  /* ---------------- event creation ---------------- */
  const pushEvent = useCallback(
    async (
      eventType: string,
      newState: ScoreState,
      opts: { teamId?: string | null; payload?: Record<string, unknown>; newStatus?: string } = {}
    ) => {
      const prev = stateRef.current;
      // Still inside the referee's tap, which is what lets the call play later.
      onVoiceEvent(eventType, prev, newState);
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
      // A final result supersedes the points before it: nothing to undo back into
      // (the server's undo stack and reopen state stop at it too). It is changed by
      // entering a correction.
      const nextHistory = (
        eventType === RESULT_ENTERED
          ? []
          : eventType === "UNDO"
          ? historyRef.current.slice(0, -1)
          : prev && pushesHistory(eventType)
            ? [...historyRef.current, withoutClock(prev)]
            : historyRef.current
      ).slice(-200);
      commit(newState, nextHistory); // synchronous ref update first — taps can be rapid
      if (opts.newStatus) setMatchStatus(opts.newStatus as Match["status"]);
      setPendingCount((c) => c + 1);
      setSyncStatus(navigator.onLine ? "syncing" : "pending");
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
    [match.id, matchStatus, trySync, commit, onVoiceEvent]
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
    // With confirmation on, the winning point records the score but does not end
    // the match: the referee confirms it first, so a mis-tap on match point is
    // caught before it reaches the standings, the bracket and the venue screen.
    stopRecordedTimer();
    const e = C.point(stateRef.current!, teamKey, consoleOpts());
    noteEnds(cur, e.next);
    recordV2(e);
    follow(e);
    setModal(null);
  }

  /* ---------------- scoring v2: serve, lets, timers ---------------- */
  const consoleOpts = (): C.ConsoleOptions => ({
    config: scoringConfig,
    confirmFirst,
    online: typeof navigator === "undefined" ? true : navigator.onLine,
    tennis,
    doubles: pairs,
  });

  /** Records a shared-console event, exactly as the app does (console.ts). */
  function recordV2(e: C.ConsoleEvent) {
    const winner = e.winner ? team(e.winner).id : null;
    void pushEvent(e.eventType, e.next, {
      teamId: e.team ? team(e.team).id : null,
      payload: winner ? { ...(e.payload ?? {}), winner_team_id: winner } : (e.payload ?? undefined),
      newStatus: e.newStatus,
    });
  }

  /** A recorded timer (changeover, set break, a break) still running stops before play goes on. */
  function stopRecordedTimer() {
    const cur = stateRef.current;
    const running = C.runningClock(cur);
    const t = timerRef.current;
    if (cur && running && !cur.matchOver) {
      const started = Date.parse(running.startedAt);
      recordV2(C.timerStop(cur, running.kind, (wallClock() - (Number.isFinite(started) ? started : wallClock())) / 1000, running.team));
    }
    if (t) putTimer(null);
  }

  /** After a step that moved the score: the changeover / set break (recorded) or the 25 s (on this console). */
  function follow(e: C.ConsoleEvent) {
    const next = C.followingTimer(e.after, features);
    if (!next || e.next.matchOver) return putTimer(null);
    const at = wallClock();
    if (next.record) recordV2(C.timerStart(stateRef.current!, next.kind, new Date(at).toISOString()));
    putTimer({ kind: next.kind, startedAt: at, team: null, recorded: next.record });
  }

  /** Ace, or a fault that turns out to be a double fault: like a point, checked when it wins a game. */
  function v2Point(action: "ace" | "fault") {
    const cur = stateRef.current;
    if (!cur || finished || matchStatus === "paused") return;
    const e = action === "ace" ? C.aceEvent(cur, consoleOpts()) : C.faultEvent(cur, consoleOpts());
    if (!e) return;
    if (e.eventType === "POINT_AWARDED" && e.team) {
      const what = C.pointNeedsConfirm(cur, e.team, consoleOpts());
      if (what) {
        setModal({ kind: "confirm-point", team: e.team, action, message: `${action === "ace" ? "Ace" : "Double fault"}: ${team(e.team).name} is about to win ${what}.` });
        return;
      }
    }
    applyV2(action);
  }

  function applyV2(action: "ace" | "fault") {
    const cur = stateRef.current;
    if (!cur) return;
    stopRecordedTimer();
    const e = action === "ace" ? C.aceEvent(stateRef.current!, consoleOpts()) : C.faultEvent(stateRef.current!, consoleOpts());
    if (!e) return;
    recordV2(e);
    if (e.eventType === "POINT_AWARDED") {
      noteEnds(cur, e.next);
      follow(e);
    } else if (timerRef.current && !timerRef.current.recorded) {
      // A first fault: the 25 s is over, the second serve follows at once.
      putTimer(null);
    }
    setModal(null);
  }

  function recordLet(kind: "serve" | "point") {
    const cur = stateRef.current;
    if (!cur || cur.matchOver) return;
    const e = C.letEvent(cur, kind);
    if (e) recordV2(e);
    setModal(null);
  }

  function startBreak(kind: TimerKind, who: TeamKey | null) {
    const cur = stateRef.current;
    if (!cur || cur.matchOver) return;
    stopRecordedTimer();
    const at = wallClock();
    recordV2(C.timerStart(stateRef.current!, kind, new Date(at).toISOString(), who));
    putTimer({ kind, startedAt: at, team: who, recorded: true });
    setModal(null);
  }

  function endTimer() {
    const t = timerRef.current;
    if (!t) return;
    if (t.recorded) stopRecordedTimer();
    else putTimer(null);
  }

  function decideTime(decision: TimeDecision, who: TeamKey | null) {
    const t = timerRef.current;
    const cur = stateRef.current;
    if (!t || !cur) return setModal(null);
    const seconds = (wallClock() - t.startedAt) / 1000;
    recordV2(C.timeDecision(cur, t.kind, decision, seconds, who));
    endTimer();
    setModal(null);
    if (decision === "code_violation" && who) recordViolation(who, "time");
  }

  function askTimeTeam(decision: TimeDecision) {
    const t = timerRef.current;
    if (!t) return;
    if (decision === "no_action") return decideTime("no_action", null);
    setModal({ kind: "time-team", decision, timer: t.kind, seconds: Math.round((wallClock() - t.startedAt) / 1000) });
  }

  /** The existing assistance call (migration 0035): every master referee on duty is alerted. */
  async function callMasterNow() {
    setCallNote("Calling…");
    try {
      const res = await fetch("/api/mobile/v1/referee/assistance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "request", matchId: match.id }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setCallNote(res.ok ? "Master referee called. Their answer shows under the header." : (body.error ?? "The call could not be sent. Call the desk."));
    } catch {
      setCallNote("No connection. Call the desk.");
    }
  }

  function confirmServeOrder(order: ServeOrder) {
    const cur = stateRef.current;
    if (!cur) return;
    // After the first set the serving team is the rotation's; the referee picks the partners.
    const e = C.serveOrderEvent(cur, lockServeOrder(cur, order), pairs);
    if (e) recordV2(e);
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

  /**
   * A final result typed in one go. Checked here before it is queued; a match that
   * is already finished is corrected online (the server reopens and re-finalises
   * it), anything else goes through the offline queue like a point.
   */
  async function submitResult(payload: ResultPayload) {
    const q = queueableResult({ mode: scoringMode, engine: "games", rules: scoringConfig, payload });
    if (!q.ok) {
      setResultError({ message: q.problems[0]?.message ?? "Check the score.", problems: q.problems });
      return;
    }
    const winnerId = q.winner ? team(q.winner).id : null;
    if (FINISHED.includes(renderStatus)) {
      setResultBusy(true);
      try {
        const st = await fetch(`/api/matches/${match.id}/state`, { cache: "no-store" });
        const data = (await st.json()) as { snapshot: MatchSnapshot | null };
        const res = await fetch(`/api/matches/${match.id}/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            deviceId: deviceIdRef.current,
            events: [
              {
                client_event_id: crypto.randomUUID(),
                event_number: (data.snapshot?.last_event_number ?? 0) + 1,
                event_type: RESULT_ENTERED,
                team_id: winnerId,
                previous_state: data.snapshot?.snapshot_json ?? null,
                new_state: q.state,
                payload,
                created_at_client: new Date().toISOString(),
              },
            ],
          }),
        });
        if (res.ok) {
          await offlineDb.matchState.delete(match.id);
          window.location.reload();
          return;
        }
        const body = (await res.json().catch(() => null)) as { error?: string; problems?: ResultProblem[] } | null;
        setResultError({ message: body?.error ?? "The correction was not recorded.", problems: body?.problems ?? [] });
      } catch {
        setResultError({ message: "A correction needs a connection. Try again when online.", problems: [] });
      } finally {
        setResultBusy(false);
      }
      return;
    }
    setResultError(null);
    setModal(null);
    void pushEvent(RESULT_ENTERED, q.state as ScoreState, {
      teamId: winnerId,
      payload: payload as unknown as Record<string, unknown>,
      newStatus: q.over ? (navigator.onLine ? "completed" : "pending_sync") : "live",
    });
  }

  function openResultEntry(correcting: boolean) {
    setResultError(null);
    setModal({
      kind: "final-result",
      correcting,
      initial: correcting && renderState?.completedSets.length ? { sets: enteredSetsFromState(renderState) } : null,
    });
  }

  function doUndo() {
    const cur = stateRef.current;
    if (historyRef.current.length === 0 || !cur) return setModal(null);
    // Back to the state before the last scoring step, never with a timer that ran there (timing.ts).
    const prev = withoutClock(historyRef.current[historyRef.current.length - 1]);
    void pushEvent("UNDO", prev, { newStatus: finished ? "live" : undefined });
    setRest(null);
    // The 25 s belonged to the point taken back; a recorded timer stays until it is stopped.
    if (timerRef.current && !timerRef.current.recorded) putTimer(null);
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
    if (!cur || cur.matchOver) return;
    // In a tie-break this corrects who serves now; the rotation follows from it.
    const next = changeServer(cur, currentServer(cur) === "A" ? "B" : "A");
    void pushEvent("SERVER_CHANGED", next);
  }

  function recordViolation(offender: TeamKey, offence: Offence) {
    const cur = stateRef.current;
    if (!cur || cur.matchOver) return;
    const e = C.violation(cur, offender, offence, { ...consoleOpts(), doubles });
    if (!e) return;
    noteEnds(cur, e.next);
    recordV2(e);
    if (e.after?.timer) follow(e);
    setModal(null);
  }

  function swapServerInTeam(k: TeamKey) {
    const cur = stateRef.current;
    if (!cur || cur.matchOver) return;
    void pushEvent("SERVER_CHANGED", swapDoublesServer(cur, k));
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
    if (!renderState) return "0";
    if (renderState.isTiebreak) return String(k === "A" ? renderState.teamA.tiebreakPoints : renderState.teamB.tiebreakPoints);
    return k === "A" ? renderState.teamA.points : renderState.teamB.points;
  }

  if (!control.ready) {
    return <div className="flex flex-1 items-center justify-center p-10 text-muted">Connecting…</div>;
  }

  const notStarted = renderStatus === "scheduled" || renderStatus === "ready" || !renderState;
  // Recorded as a final result only: no points on this console.
  const resultOnly = scoringMode === "final_score";
  // A result entered now replaces points already scored (the server logs it as a correction).
  const scoredSoFar = Boolean(
    renderState &&
      (renderState.completedSets.length > 0 ||
        renderState.teamA.games + renderState.teamB.games > 0 ||
        renderState.teamA.points !== "0" ||
        renderState.teamB.points !== "0"),
  );
  const servingNow = doubles && renderState && !renderState.matchOver ? servingPlayer(renderState) : null;
  const bothCheckedIn = teamA.checkedIn && teamB.checkedIn;
  const v2Sides: Record<TeamKey, V2Side> = {
    A: { name: teamA.nation ? (nationByCode(teamA.nation)?.name ?? teamA.nation) : teamA.name, code: shortCode(teamA.name, teamA.nation), players: teamA.players.map((p) => p.name) },
    B: { name: teamB.nation ? (nationByCode(teamB.nation)?.name ?? teamB.nation) : teamB.name, code: shortCode(teamB.name, teamB.nation), players: teamB.players.map((p) => p.name) },
  };
  // The referee's left and right: auto swap follows the change of ends; More → Swap flips it.
  const swapped = sidesSwapped(renderState, { auto: features.autoSwap, manual: features.manualSwap && manualSwap });
  const askOrder =
    !readOnly && !finished && features.doublesOrder && pairs && matchStatus !== "paused" && renderState !== null && needsServeOrder(renderState, true);

  return (
    <div className={`${sunlight ? "theme-sunlight " : ""}mx-auto flex min-h-screen w-full max-w-3xl flex-col bg-background p-3 text-foreground`} data-theme-mode={sunlight ? "sunlight" : "auto"}>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
        <div>
          <p className="text-xs text-muted">{tournamentName} · {courtName} · {match.round_name}</p>
          {/* The rules this match resolved to. Stage overrides mean two matches in
              the same tournament can differ, so the referee is told which applies. */}
          {/* Once play is on, the scoreboard card carries the rules (and the Sunlight switch). */}
          {!renderState && <p className="text-[11px] text-muted" data-testid="resolved-rules">{describeMatchRules(scoringConfig)}</p>}
          <p className="text-xs font-semibold capitalize">
            {renderStatus.replace("_", " ")}
            {elapsed && !renderFinished && <span className="ml-2 font-mono text-muted">⏱ {elapsed}</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 [&>*]:whitespace-nowrap">
          {!readOnly && (
            <button
              type="button"
              onClick={() => setModal({ kind: "voice" })}
              className={`badge ${voice.status === "off" ? "bg-card text-muted" : voice.status === "ready" ? "bg-success/15 text-success" : "bg-warning/15 text-warning"}`}
              data-testid="voice-button"
              aria-label="Voice umpire"
            >
              {voice.status === "off" ? "🔈 Voice off" : "🔊 Voice"}
            </button>
          )}
          {!readOnly && voice.status !== "off" && (
            <button
              type="button"
              onClick={() => voice.setSettings({ muted: !voice.settings.muted })}
              className={`badge ${voice.settings.muted ? "bg-danger/15 text-danger" : "bg-card text-foreground"}`}
              aria-pressed={voice.settings.muted}
              aria-label={voice.settings.muted ? "Unmute the voice" : "Mute the voice"}
              data-testid="voice-mute"
            >
              {voice.settings.muted ? "🔇 Muted" : "🔇 Mute"}
            </button>
          )}
          {!renderState && (
            <button
              type="button"
              onClick={() => setSunlight(!sunlight)}
              className={`badge ${sunlight ? "bg-warning/20 text-foreground" : "bg-card text-muted"}`}
              aria-pressed={sunlight}
              data-testid="sunlight"
            >
              {sunlight ? "☀ Sunlight on" : "☀ Sunlight"}
            </button>
          )}
          <span className={`badge ${statusBadge[1]}`}>{statusBadge[0]}</span>
          <Link href={`/referee/tournaments/${match.tournament_id}/matches`} className="text-xs text-muted hover:text-foreground">
            ← Matches
          </Link>
        </div>
      </div>
      {assistance && <div className="pb-2">{assistance}</div>}
      {syncError && (
        <p className="mb-2 rounded-xl bg-danger/15 px-3 py-2 text-xs font-semibold text-danger">
          {syncError}
        </p>
      )}
      {!finished && !controlDisabled && <ControlPanel control={guardedControl} pendingCount={pendingCount} />}

      {/* Calling the match to its court, until it starts (same card as the app). */}
      {notStarted && matchDay && (
        <div className="flex justify-center pb-3">
          <CallCard
            matchId={match.id}
            rules={matchDay}
            initialCall={initialCall}
            matchStatus={renderStatus}
            hasCourt={Boolean(match.court_id)}
            names={{ A: teamA.name, B: teamB.name }}
            deviceId={() => deviceIdRef.current}
            onDecided={() => window.location.reload()}
          />
        </div>
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
          ) : resultOnly ? (
            <div className="w-full max-w-sm space-y-3 text-center">
              <p className="text-sm text-muted">This match is recorded as a final result.</p>
              <button className="btn-primary w-full justify-center py-4 text-lg" onClick={() => openResultEntry(false)} data-testid="final-result-button">
                Enter final result
              </button>
            </div>
          ) : (
            <div className="w-full max-w-sm space-y-3 text-center">
              {resultAllowed && (
                <button className="btn-secondary w-full justify-center" onClick={() => openResultEntry(false)} data-testid="final-result-button">
                  Enter final result instead
                </button>
              )}
              <p className="label">Who serves first?</p>
              <div className="grid grid-cols-2 gap-3">
                {(["A", "B"] as TeamKey[]).map((k) => (
                  <button
                    key={k}
                    className="card flex flex-col items-center gap-2 border-2 py-6 hover:border-accent"
                    style={redBlue ? { borderColor: SIDES[k].hex, background: sideTint(k, 0.1) } : undefined}
                    onClick={() => startMatch(k)}
                  >
                    <span className="text-3xl">🎾</span>
                    {redBlue && <SideChip side={k} />}
                    <span className="font-bold">{team(k).name}</span>
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted">Tapping a team starts the match with that team serving.</p>
            </div>
          )}
        </div>
      ) : renderState ? (
        <>
          {/* Scoreboard (v2) */}
          <BoardV2
            state={renderState}
            sides={v2Sides}
            eyebrow={[`${v2Sides.A.code} vs ${v2Sides.B.code}`, match.round_name, courtName].filter(Boolean).join(" · ")}
            rules={describeMatchRules(scoringConfig)}
            sunlight={sunlight}
            onSunlight={() => setSunlight(!sunlight)}
            doubles={pairs}
            aces={features.ace && (renderState.stats?.aces.A || renderState.stats?.aces.B) ? aceCounts(renderState) : null}
            aceNow={features.ace && aceMoment(renderState)}
            banner={
              timer && timer.kind === "between_points" && !readOnly && !renderState.matchOver ? (
                <BetweenPointsBanner timer={timer} now={tick} onDismiss={endTimer} onDecision={askTimeTeam} />
              ) : null
            }
          />
          {renderState.isTiebreak && !renderState.matchOver && (
            <p className="mt-1 text-center text-xs font-bold uppercase tracking-widest text-accent" data-testid="tiebreak-banner">
              {renderState.isMatchTiebreak
                ? `Match tie-break · first to ${scoringConfig.matchTiebreakPoints || 10}, win by 2`
                : `Tie-break · first to ${scoringConfig.tiebreakTargetPoints}${scoringConfig.tiebreakWinByTwo ? ", win by 2" : ""}`}
            </p>
          )}
          {scoringConfig.decidingPoint &&
            !renderState.isTiebreak &&
            !renderState.matchOver &&
            renderState.teamA.points === "40" &&
            renderState.teamB.points === "40" && (
              <p className="mt-1 text-center text-xs font-bold uppercase tracking-widest text-warning" data-testid="deciding-point">
                Deciding point · the receivers choose who receives
              </p>
            )}
          {servingNow && !pairs && (
            <div className="mt-2 flex flex-wrap items-center justify-center gap-2 text-sm" data-testid="serving-player">
              <span>
                🎾 Serving: <b>{team(servingNow.team).players[servingNow.index]?.name ?? team(servingNow.team).name}</b>
              </span>
              {!readOnly && (
                <button className="btn-secondary px-2 py-1 text-xs" onClick={() => swapServerInTeam(servingNow.team)}>
                  Other {team(servingNow.team).name} player serves
                </button>
              )}
            </div>
          )}
          {tennis && rest && !renderState.matchOver && !features.timerChangeover && !features.timerSetBreak && (() => {
            const left = Math.max(0, Math.ceil((rest.endsAt - now) / 1000));
            const title =
              rest.kind === "set_break" ? "Set break" : rest.kind === "tiebreak" ? "Change ends" : left > 0 ? "Changeover" : "Change ends";
            return (
              <div className="card mt-2 flex items-center justify-between gap-3 border-accent/60" data-testid="rest-clock">
                <div>
                  <p className="font-bold">
                    {title}
                    {rest.changeEnds && rest.kind === "set_break" ? " · change ends" : ""}
                  </p>
                  <p className="text-xs text-muted">
                    {left > 0 ? "Players rest. Call time when the clock runs out." : "Time. Play resumes."}
                  </p>
                </div>
                {left > 0 && <span className="font-mono text-3xl font-bold tabular-nums">{Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</span>}
                <button className="btn-secondary px-3 py-2 text-xs" onClick={() => setRest(null)}>
                  {left > 0 ? "Resume now" : "Dismiss"}
                </button>
              </div>
            );
          })()}

          {/* Awaiting confirmation: the score is final, the result is not yet. */}
          {awaitingConfirmation && (
            <div className="card mt-3 space-y-3 border-warning/60 text-center">
              <p className="text-lg font-bold">
                {renderState.winner ? team(renderState.winner).name : "Match"} wins {scoreSummary(renderState) || ""}
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
          {!awaitingConfirmation && (renderFinished || renderState.matchOver) && (
            <div className="card mt-3 border-success/50 text-center">
              <p className="text-lg font-bold text-success">
                🏆 {renderState.winner ? team(renderState.winner).name : "Match ended"} wins
              </p>
              <p className="text-sm text-muted">Final score: {scoreSummary(renderState) || "—"}</p>
              {pendingCount > 0 && (
                <p className="mt-1 text-xs font-semibold text-warning">
                  Result will be official after sync ({pendingCount} pending).
                </p>
              )}
              <div className="mt-2 flex flex-wrap justify-center gap-2">
                {!readOnly && (
                  <button className="btn-secondary text-xs" onClick={() => setModal({ kind: "confirm-undo" })}>
                    Undo (reopen match)
                  </button>
                )}
                {resultAllowed && renderFinished && pendingCount === 0 && canCorrect && (
                  <button className="btn-secondary text-xs" onClick={() => openResultEntry(true)} data-testid="correct-result-button">
                    Correct result
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Score buttons */}
          {!readOnly && !finished && !renderState.matchOver && resultOnly && (
            <button className="btn-primary mt-3 w-full justify-center py-4 text-lg" onClick={() => openResultEntry(scoredSoFar)} data-testid="final-result-button">
              Enter final result
            </button>
          )}
          {!readOnly && !finished && !renderState.matchOver && !resultOnly && (
            <PadV2
              state={renderState}
              sides={v2Sides}
              features={features}
              swapped={swapped}
              disabled={false}
              canUndo={history.length > 0}
              paused={matchStatus === "paused"}
              onPoint={tapScore}
              onFault={() => v2Point("fault")}
              onAce={() => v2Point("ace")}
              onLet={() => setModal({ kind: "let" })}
              onUndo={() => setModal({ kind: "confirm-undo" })}
              onPause={togglePause}
              onServe={switchServer}
              onMore={() => setModal({ kind: "more" })}
            />
          )}
          {tennis && (renderState.violations?.length ?? 0) > 0 && (
            <div className="card mt-2 space-y-1 text-sm" data-testid="violation-log">
              <p className="label">Code violations</p>
              {renderState.violations!.map((v, i) => (
                <p key={i} className="flex justify-between gap-2">
                  <span>{team(v.team).name} · {OFFENCE_LABELS[v.offence]}</span>
                  <span className={v.penalty === "warning" ? "text-muted" : "font-semibold text-warning"}>{PENALTY_LABELS[v.penalty]}</span>
                </p>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center text-muted">Waiting for match to start…</div>
      )}

      {/* ------------- Scoring v2: timer card and the doubles set-start question ------------- */}
      {timer && timer.kind !== "between_points" && !readOnly && renderState && !renderState.matchOver && !modal && (
        <TimerCard timer={timer} now={tick} sides={v2Sides} onStop={endTimer} onDecision={askTimeTeam} />
      )}
      {askOrder && renderState && !modal && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-3 sm:items-center">
          <div className="w-full max-w-md rounded-[24px] border border-border bg-card p-5">
            <ServeOrderDialog
              key={renderState.currentSet}
              set={renderState.currentSet}
              sides={v2Sides}
              initial={defaultServeOrder(renderState)}
              teamFree={tossDecidesServer(renderState)}
              onConfirm={confirmServeOrder}
            />
          </div>
        </div>
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
                  <button
                    className="btn-primary flex-1"
                    onClick={() => (modal.action === "ace" || modal.action === "fault" ? applyV2(modal.action) : applyPoint(modal.team))}
                  >
                    Confirm
                  </button>
                </div>
              </>
            )}
            {modal.kind === "violation" && state && (
              <>
                <h3 className="font-bold">Code violation</h3>
                <div className="grid grid-cols-2 gap-2">
                  {(["A", "B"] as TeamKey[]).map((k) => (
                    <button
                      key={k}
                      className={modal.team === k ? "btn-primary" : "btn-secondary"}
                      onClick={() => setModal({ ...modal, team: k })}
                    >
                      {team(k).name}
                    </button>
                  ))}
                </div>
                <label className="label" htmlFor="offence">Offence</label>
                <select
                  id="offence"
                  className="input"
                  value={modal.offence}
                  onChange={(e) => setModal({ ...modal, offence: e.target.value as Offence })}
                >
                  {(Object.keys(OFFENCE_LABELS) as Offence[]).map((o) => (
                    <option key={o} value={o}>{OFFENCE_LABELS[o]}</option>
                  ))}
                </select>
                {modal.team && (
                  <p className="text-sm" data-testid="violation-penalty">
                    Penalty:{" "}
                    <b>{PENALTY_LABELS[nextPenalty(state, modal.team, modal.offence, currentServer(state) === modal.team)]}</b>
                    <span className="block text-xs text-muted">
                      Warning, then point penalty, then a game penalty for each further code violation. A default is
                      the referee&apos;s call: use End match → Disqualification.
                    </span>
                  </p>
                )}
                <div className="flex gap-2">
                  <button className="btn-secondary flex-1" onClick={() => setModal(null)}>Cancel</button>
                  <button
                    className="btn-danger flex-1"
                    disabled={!modal.team}
                    onClick={() => modal.team && recordViolation(modal.team, modal.offence)}
                  >
                    Record
                  </button>
                </div>
              </>
            )}
            {modal.kind === "let" && (
              <div className="space-y-2" data-testid="let-choice">
                <h3 className="text-xl font-black uppercase">Let</h3>
                <button className="w-full rounded-2xl border border-border bg-background p-4 text-left" onClick={() => recordLet("serve")} data-testid="let-serve">
                  <span className="block font-bold">⊕ Serve let — replay this serve</span>
                  <span className="block text-xs text-muted">
                    Serve touched the net and landed in. Same serve again{renderState && renderState.serve && renderState.serve.fault ? ": still the 2nd serve." : "."}
                  </span>
                </button>
                <button className="w-full rounded-2xl border border-border bg-background p-4 text-left" onClick={() => recordLet("point")} data-testid="let-point">
                  <span className="block font-bold">↶ Replay point — interference</span>
                  <span className="block text-xs text-muted">Something interfered with play. The whole point is replayed from the 1st serve.</span>
                </button>
                <button className="btn-secondary w-full py-3" onClick={() => setModal(null)}>Cancel</button>
              </div>
            )}
            {modal.kind === "more" && (
              <div className="max-h-[80vh] space-y-3 overflow-y-auto" data-testid="more-sheet">
                <h3 className="text-xl font-black uppercase">More</h3>
                {features.callMaster && callMaster && (
                  <button className="w-full rounded-2xl py-3.5 text-base font-black text-white" style={{ background: "#e11d48" }} onClick={() => setModal({ kind: "call" })} data-testid="more-call-master">
                    📣 Call master referee
                  </button>
                )}
                {callNote && <p className="text-xs font-semibold text-muted">{callNote}</p>}
                {(features.breakStopwatch || features.timerChangeover || features.timerSetBreak || features.bathroom || features.hydration) && (
                  <div className="space-y-1.5">
                    <p className="label">Breaks</p>
                    {(
                      [
                        ["break", features.breakStopwatch, "⏱ Break", "Stopwatch"],
                        ["changeover", features.timerChangeover, "◷ Changeover", "1:30"],
                        ["set_break", features.timerSetBreak, "☕ Set break", "2:00"],
                        ["bathroom", features.bathroom, "🚻 Bathroom break", "warns 10:00"],
                        ["hydration", features.hydration, "💧 Hydration break", "10:00"],
                      ] as [TimerKind, boolean, string, string][]
                    )
                      .filter(([, on]) => on)
                      .map(([k, , label, hint]) => (
                        <button
                          key={k}
                          className="flex w-full items-center justify-between rounded-xl border border-border bg-background px-3 py-2.5 text-sm font-bold"
                          onClick={() => (k === "bathroom" ? setModal({ kind: "break-team", timer: k }) : startBreak(k, null))}
                          data-testid={`break-${k}`}
                        >
                          {label}
                          <span className="font-mono text-xs font-normal text-muted">{hint}</span>
                        </button>
                      ))}
                  </div>
                )}
                {(features.manualSwap || features.matchLog || pairs) && (
                  <div className="space-y-1.5">
                    <p className="label">Court</p>
                    <div className="grid grid-cols-2 gap-2">
                      {features.manualSwap && (
                        <button className="btn-secondary py-2.5" onClick={() => { toggleSwap(); setModal(null); }} data-testid="more-swap">
                          Swap left / right
                        </button>
                      )}
                      {features.matchLog && (
                        <button className="btn-secondary py-2.5" onClick={() => setModal({ kind: "log" })} data-testid="more-log">
                          Match log
                        </button>
                      )}
                      {pairs && (
                        <button className="btn-secondary py-2.5 text-xs" onClick={() => { swapServerInTeam("A"); setModal(null); }}>
                          Other {v2Sides.A.name} player serves
                        </button>
                      )}
                      {pairs && (
                        <button className="btn-secondary py-2.5 text-xs" onClick={() => { swapServerInTeam("B"); setModal(null); }}>
                          Other {v2Sides.B.name} player serves
                        </button>
                      )}
                    </div>
                  </div>
                )}
                <div className="space-y-1.5">
                  <p className="label">Match</p>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    {tennis && (
                      <button className="btn-secondary py-2.5" onClick={() => setModal({ kind: "violation", team: null, offence: "time" })} data-testid="violation-button">
                        Code violation
                      </button>
                    )}
                    {resultAllowed && (
                      <button className="btn-secondary py-2.5" onClick={() => openResultEntry(scoredSoFar)} data-testid="final-result-button">
                        Enter final result
                      </button>
                    )}
                    <button className="btn-secondary py-2.5" onClick={() => setModal({ kind: "end-set", team: null })}>End the set</button>
                    <button className="btn-secondary py-2.5" onClick={() => setModal({ kind: "retire", team: null })}>Retirement</button>
                    <button className="btn-secondary py-2.5" onClick={() => setModal({ kind: "walkover", absent: null })}>Walkover</button>
                    <button className="btn-secondary py-2.5 text-danger" onClick={() => setModal({ kind: "disqualify", team: null })}>Disqualification</button>
                    <button className="btn-secondary py-2.5" onClick={() => setModal({ kind: "force-end", winner: null })}>End the match now</button>
                    {voice.status !== "off" && (
                      <button className="btn-secondary py-2.5" onClick={() => { voice.setSettings({ muted: !voice.settings.muted }); setModal(null); }} data-testid="voice-mute-control">
                        {voice.settings.muted ? "🔊 Unmute voice" : "🔇 Mute voice"}
                      </button>
                    )}
                  </div>
                </div>
                <button className="btn-secondary w-full" onClick={() => setModal(null)}>Close</button>
              </div>
            )}
            {modal.kind === "call" && (
              <div className="space-y-3 text-center" data-testid="call-confirm">
                <p className="mx-auto flex h-12 w-12 items-center justify-center rounded-full text-xl text-white" style={{ background: "#e11d48" }}>📣</p>
                <h3 className="text-xl font-bold">Call the master referee to {courtName}?</h3>
                <p className="text-sm text-muted">Every master referee on duty gets an alert.</p>
                <button
                  className="w-full rounded-2xl py-3 font-bold text-white"
                  style={{ background: "#e11d48" }}
                  data-testid="call-confirm-yes"
                  onClick={() => {
                    setModal(null);
                    void callMasterNow();
                  }}
                >
                  Call
                </button>
                <button className="btn-secondary w-full py-3" onClick={() => setModal(null)}>Cancel</button>
              </div>
            )}
            {modal.kind === "log" && <MatchLogPanel matchId={match.id} onClose={() => setModal(null)} />}
            {modal.kind === "break-team" && (
              <>
                <h3 className="font-bold">{TIMERS[modal.timer].label}: which side?</h3>
                <div className="grid grid-cols-2 gap-2">
                  {(["A", "B"] as TeamKey[]).map((k) => (
                    <button key={k} className="btn-secondary py-3" onClick={() => startBreak(modal.timer, k)} data-testid={`break-team-${k}`}>
                      {v2Sides[k].name}
                    </button>
                  ))}
                </div>
                <button className="btn-secondary w-full" onClick={() => setModal(null)}>Cancel</button>
              </>
            )}
            {modal.kind === "time-team" && (
              <>
                <h3 className="font-bold">
                  {modal.decision === "code_violation" ? "Code violation (time)" : "Warning"}: which side?
                </h3>
                <p className="text-sm text-muted">{TIMERS[modal.timer].label} · over by {Math.max(0, modal.seconds - (TIMERS[modal.timer].limit ?? 0))} s</p>
                <div className="grid grid-cols-2 gap-2">
                  {(["A", "B"] as TeamKey[]).map((k) => (
                    <button key={k} className="btn-secondary py-3" onClick={() => decideTime(modal.decision, k)} data-testid={`time-team-${k}`}>
                      {v2Sides[k].name}
                    </button>
                  ))}
                </div>
                <button className="btn-secondary w-full" onClick={() => setModal(null)}>Cancel</button>
              </>
            )}
            {modal.kind === "voice" && (
              <VoicePanel voice={voice} onClose={() => setModal(null)} />
            )}
            {modal.kind === "final-result" && (
              <FinalScoreEntry
                engine="games"
                rules={scoringConfig}
                sideA={teamA.name}
                sideB={teamB.name}
                initial={modal.initial}
                correcting={modal.correcting}
                busy={resultBusy}
                error={resultError?.message ?? null}
                problems={resultError?.problems ?? null}
                onSubmit={(payload) => void submitResult(payload)}
                onCancel={() => {
                  setResultError(null);
                  setModal(null);
                }}
              />
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

"use client";

import { useEffect, useRef, useState } from "react";
import { endsChange, scoreSummary, type ScoreState, type TeamKey } from "@/lib/scoring/engine";
import { replayResult } from "@/lib/tennis/replay";
import { WALKON } from "@/lib/tennis/tvScene";
import type { ScoringConfig } from "@/lib/types";
import { sameScore } from "@/lib/voice/calls";
import { replayProgressAction } from "./actions";

export interface ReplayRubber {
  id: string;
  label: string;
  teamA: string | null;
  teamB: string | null;
  /** The known result, from team A's side. */
  line: string;
  rules: ScoringConfig;
}

export interface ReplayTie {
  id: string;
  title: string;
  where: string;
  rubbers: ReplayRubber[];
}

/** Seconds between points. The slowest is about a real match's pace. */
const PACES = [
  [1.5, "Fast check (1.5 s a point)"],
  [4, "Quick (4 s a point)"],
  [8, "Broadcast (8 s a point)"],
  [20, "Real time (20 s a point)"],
] as const;
/** After a rubber: the TV's "rubber won" card and the tie score, before the next walk-on. */
const BETWEEN_RUBBERS_MS = 30_000;
const FINISHED = ["completed", "walkover", "retired", "disqualified", "cancelled"];
const DEVICE_KEY = "mb_replay_device";

function deviceId(): string {
  try {
    const stored = localStorage.getItem(DEVICE_KEY);
    if (stored) return stored;
    const id = `replay-${crypto.randomUUID()}`;
    localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    return `replay-${crypto.randomUUID()}`;
  }
}

/** A stable seed per rubber, so a reload replays the same points it started with. */
function seedOf(id: string): number {
  let h = 2166136261;
  for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

function check(line: string, rules: ScoringConfig): string | null {
  if (!line.trim()) return "No result to replay.";
  try {
    replayResult(line, rules, 1);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Not a result these rules can reach.";
  }
}

/** Waits, in short steps so Pause is felt at once. False when paused. */
async function wait(ms: number, stop: { current: boolean }): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (stop.current) return false;
    await new Promise((r) => setTimeout(r, Math.min(250, until - Date.now())));
  }
  return !stop.current;
}

/** One event, as a referee's phone sends it. */
async function send(matchId: string, device: string, n: number, type: string, prev: ScoreState | null, next: ScoreState, teamId: string | null, payload: unknown = null) {
  const res = await fetch(`/api/matches/${matchId}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceId: device,
      events: [{ client_event_id: crypto.randomUUID(), event_number: n, event_type: type, team_id: teamId, previous_state: prev, new_state: next, payload, created_at_client: new Date().toISOString() }],
    }),
  });
  if (!res.ok) throw new Error(`${type}: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

export default function ReplayConsole({ tournamentId, ties }: { tournamentId: string; ties: ReplayTie[] }) {
  const [lines, setLines] = useState<Record<string, string>>(() =>
    Object.fromEntries(ties.flatMap((t) => t.rubbers.map((r) => [r.id, r.line]))),
  );
  const [pace, setPace] = useState<number>(4);
  const [running, setRunning] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const stopRef = useRef(false);
  const paceRef = useRef(pace);
  useEffect(() => {
    paceRef.current = pace;
  }, [pace]);

  const note = (id: string, text: string) => setProgress((p) => ({ ...p, [id]: text }));
  const sleep = (ms: number) => wait(ms, stopRef);

  async function playRubber(r: ReplayRubber, device: string): Promise<"done" | "skipped" | "stopped"> {
    const [now] = await replayProgressAction(tournamentId, [r.id]);
    if (!now || FINISHED.includes(now.status)) {
      note(r.id, now?.status === "cancelled" ? "Not played (tie decided)" : "Finished");
      return "skipped";
    }
    if (!lines[r.id]?.trim()) {
      note(r.id, "No result given: skipped");
      return "skipped";
    }
    const { states, points } = replayResult(lines[r.id], r.rules, seedOf(r.id));
    const teamOf = (k: TeamKey) => (k === "A" ? r.teamA : r.teamB);
    let at = 0;
    let n = now.lastEventNumber;
    if (now.state) {
      at = states.findLastIndex((s) => sameScore(s, now.state!));
      if (at < 0) throw new Error(`${r.label}: the score on court is not on this replay's path, so it cannot carry on.`);
    }
    const claim = await fetch(`/api/matches/${r.id}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: device, deviceLabel: "Replay console" }),
    });
    if (!claim.ok) throw new Error(`${r.label}: another device is scoring it (${claim.status}). Release its lock on the Rubbers page first.`);

    if (!now.state) {
      await send(r.id, device, ++n, "MATCH_STARTED", null, states[0], null, { first_server: "A" });
      note(r.id, "Walk-on…");
      if (!(await sleep(WALKON.totalMs + 1_000))) return "stopped";
    }
    for (let i = at; i < states.length - 1; i++) {
      if (stopRef.current) return "stopped";
      const next = states[i + 1];
      await send(r.id, device, ++n, "POINT_AWARDED", states[i], next, teamOf(points[i]));
      note(r.id, `${i + 1}/${states.length - 1} points · ${scoreSummary(next)}`);
      // Changeovers and set breaks get a longer pause, as on court.
      const rest = endsChange(states[i], next).restSeconds > 0;
      if (!(await sleep(paceRef.current * 1000 * (rest ? 3 : 1)))) return "stopped";
    }
    const last = states[states.length - 1];
    const winner = teamOf(last.winner!);
    await send(r.id, device, ++n, "MATCH_ENDED", last, last, winner, { winner_team_id: winner });
    note(r.id, `Finished · ${scoreSummary(last)}`);
    return "done";
  }

  async function playTie(tie: ReplayTie) {
    setMessage(null);
    stopRef.current = false;
    setRunning(tie.id);
    const device = deviceId();
    try {
      for (const [i, r] of tie.rubbers.entries()) {
        const result = await playRubber(r, device);
        if (result === "stopped") return setMessage("Paused. Play again to carry on from this point.");
        const more = tie.rubbers.slice(i + 1).length > 0;
        if (result === "done" && more && !(await sleep(BETWEEN_RUBBERS_MS))) return setMessage("Paused between rubbers.");
      }
      setMessage(`${tie.title}: replay finished.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(null);
    }
  }

  return (
    <div className="space-y-4" data-testid="replay-console">
      <div className="card flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="label">Pace</span>
          <select className="input" value={pace} onChange={(e) => setPace(Number(e.target.value))} data-testid="replay-pace">
            {PACES.map(([s, label]) => (
              <option key={s} value={s}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {running && (
          <button type="button" className="btn-secondary" onClick={() => (stopRef.current = true)} data-testid="replay-pause">
            Pause
          </button>
        )}
        {message && <p className="text-sm" data-testid="replay-message">{message}</p>}
      </div>

      {ties.map((tie) => {
        const problems = tie.rubbers.map((r) => check(lines[r.id] ?? "", r.rules));
        const ready = problems.some((p) => p === null);
        return (
          <div key={tie.id} className="card space-y-3" data-testid="replay-tie">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-bold">{tie.title}</h3>
                <p className="text-xs text-muted">{tie.where}</p>
              </div>
              <button
                type="button"
                className="btn-primary"
                disabled={running !== null || !ready}
                onClick={() => void playTie(tie)}
                data-testid="replay-play"
              >
                {running === tie.id ? "Playing…" : "Play tie"}
              </button>
            </div>
            {tie.rubbers.map((r, i) => (
              <div key={r.id} className="grid gap-1 sm:grid-cols-[1fr_12rem] sm:items-center">
                <div>
                  <p className="text-sm font-semibold">{r.label}</p>
                  <p className="text-xs text-muted" data-testid="replay-progress">
                    {progress[r.id] ?? (problems[i] ?? "Ready")}
                  </p>
                </div>
                <input
                  className="input font-mono"
                  value={lines[r.id] ?? ""}
                  onChange={(e) => setLines((l) => ({ ...l, [r.id]: e.target.value }))}
                  disabled={running !== null}
                  placeholder="6-4 6-3"
                  aria-label={`Result for ${r.label}, first-named side's games first`}
                />
              </div>
            ))}
            <p className="text-[11px] text-muted">
              Results read from the first-named side: 6-4 6-3, 7-6(5) for a tie-break set, [10-8] for a match tie-break.
              A rubber left blank is skipped; one the tie no longer needs is not played.
            </p>
          </div>
        );
      })}
    </div>
  );
}

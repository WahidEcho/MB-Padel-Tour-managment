"use client";

import { useActionState } from "react";
import { delayOrderOfPlayAction, drawPlacementAction, lockLineupsAction, resetPlacementAction, saveLineupAction, type TieFormState } from "./actions";

function Notice({ state }: { state: TieFormState }) {
  if (!state) return null;
  return <p className={`text-xs font-semibold ${state.ok ? "text-success" : "text-danger"}`} role="status">{state.message}</p>;
}

export interface SquadPlayer {
  id: string;
  name: string;
}

/** One captain's nominations for one tie. */
export function LineupForm({
  tournamentId,
  tieId,
  side,
  nation,
  squad,
  current,
  locked,
  started,
}: {
  tournamentId: string;
  tieId: string;
  side: "A" | "B";
  nation: string;
  squad: SquadPlayer[];
  current: { S1: string | null; S2: string | null; D: string[] };
  locked: boolean;
  started: boolean;
}) {
  const [state, action, pending] = useActionState(saveLineupAction, null);
  const pick = (name: string, value: string | null | undefined, label: string) => (
    <label className="flex items-center gap-2 text-xs">
      <span className="w-12 font-semibold text-muted">{label}</span>
      <select name={name} defaultValue={value ?? ""} className="input py-1 text-sm" disabled={pending}>
        <option value="">—</option>
        {squad.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
    </label>
  );
  return (
    <form action={action} className="space-y-1.5" data-testid={`lineup-${side}`}>
      <input type="hidden" name="tournament_id" value={tournamentId} />
      <input type="hidden" name="tie_id" value={tieId} />
      <input type="hidden" name="side" value={side} />
      <p className="text-xs font-bold">{nation}</p>
      {pick("S1", current.S1, "S1")}
      {pick("S2", current.S2, "S2")}
      {pick("D1", current.D[0], "D")}
      {pick("D2", current.D[1], "D")}
      {locked && (
        <input name="reason" required className="input py-1 text-xs" placeholder="Reason for the late change (recorded)" />
      )}
      <button type="submit" className="btn-secondary w-full py-1 text-xs" disabled={pending || started}>
        {locked ? "Save late change" : "Save line-up"}
      </button>
      <Notice state={state} />
    </form>
  );
}

export function LockForm({ tournamentId, tieId }: { tournamentId: string; tieId: string }) {
  const [state, action, pending] = useActionState(lockLineupsAction, null);
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="tournament_id" value={tournamentId} />
      <input type="hidden" name="tie_id" value={tieId} />
      <button type="submit" className="btn-primary py-1 text-xs" disabled={pending}>Lock line-ups</button>
      <Notice state={state} />
    </form>
  );
}

export function PlacementControls({ tournamentId, drawn, ready }: { tournamentId: string; drawn: boolean; ready: boolean }) {
  const [drawState, draw, drawing] = useActionState(drawPlacementAction, null);
  const [resetState, reset, resetting] = useActionState(resetPlacementAction, null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {!drawn ? (
        <form action={draw}>
          <input type="hidden" name="tournament_id" value={tournamentId} />
          <button type="submit" className="btn-primary" disabled={drawing || !ready} data-testid="draw-placement">
            Make the placement draws
          </button>
        </form>
      ) : (
        <form action={reset}>
          <input type="hidden" name="tournament_id" value={tournamentId} />
          <button type="submit" className="btn-secondary text-xs" disabled={resetting}>Reset placement draws</button>
        </form>
      )}
      {!drawn && !ready && <span className="text-xs text-muted">Available when every group tie is finished.</span>}
      <Notice state={drawState ?? resetState} />
    </div>
  );
}

/**
 * After rain, or a long match: push everything not yet started back, on one
 * court or all of them. The referee pauses the rubbers in play; the operator puts
 * the walls on a break.
 */
export function DelayForm({ tournamentId, courts }: { tournamentId: string; courts: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState(delayOrderOfPlayAction, null);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2" data-testid="delay-form">
      <input type="hidden" name="tournament_id" value={tournamentId} />
      <label className="text-xs">
        <span className="label">Delay by (minutes)</span>
        <input name="minutes" type="number" required min={-720} max={720} step={5} defaultValue={30} className="input w-28" />
      </label>
      <label className="text-xs">
        <span className="label">Court</span>
        <select name="court_id" className="input" defaultValue="">
          <option value="">All courts</option>
          {courts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="btn-secondary" disabled={pending}>Delay the order of play</button>
      <Notice state={state} />
    </form>
  );
}

"use client";

import { useActionState } from "react";
import { delayOrderOfPlayAction, scheduleTieAction, drawPlacementAction, lockLineupsAction, resetPlacementAction, saveLineupAction, type TieFormState } from "./actions";

function Notice({ state }: { state: TieFormState }) {
  if (!state) return null;
  return <p className={`text-xs font-semibold ${state.ok ? "text-success" : "text-danger"}`} role="status">{state.message}</p>;
}

export interface SquadPlayer {
  id: string;
  name: string;
}

/**
 * One captain's nominations for one tie: the two singles before play, the
 * doubles pair now or after the second singles (Reg 43). The squad is in the
 * nation's order of merit, No. 1 first.
 */
export function LineupForm({
  tournamentId,
  tieId,
  side,
  nation,
  squad,
  current,
  locked,
  started,
  warning,
}: {
  tournamentId: string;
  tieId: string;
  side: "A" | "B";
  nation: string;
  squad: SquadPlayer[];
  current: { S1: string | null; S2: string | null; D: string[] };
  locked: boolean;
  started: boolean;
  /** Shown above the button, e.g. a retired player named again. */
  warning?: string | null;
}) {
  const [state, action, pending] = useActionState(saveLineupAction, null);
  const pick = (name: string, value: string | null | undefined, label: string, empty = "—") => (
    <label className="flex items-center gap-2 text-xs">
      <span className="w-12 font-semibold text-muted">{label}</span>
      <select name={name} defaultValue={value ?? ""} className="input py-1 text-sm" disabled={pending}>
        <option value="">{empty}</option>
        {squad.map((p, i) => (
          <option key={p.id} value={p.id}>{i + 1}. {p.name}</option>
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
      {pick("D1", current.D[0], "D", "To be named")}
      {pick("D2", current.D[1], "D", "To be named")}
      {warning && <p className="text-xs font-semibold text-danger">{warning}</p>}
      {locked && (
        <input name="reason" className="input py-1 text-xs" placeholder="Reason, for a singles change after the lock (recorded)" />
      )}
      <button type="submit" className="btn-secondary w-full py-1 text-xs" disabled={pending || started}>
        {locked ? "Save doubles or late change" : "Save line-up"}
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
      <button type="submit" className="btn-primary py-1 text-xs" disabled={pending} title="The doubles can still be named after the second singles">Lock line-ups</button>
      <Notice state={state} />
    </form>
  );
}

/**
 * The placement draws. Group winners (and third-placed nations) have fixed
 * lines; the runners-up (and fourth-placed) are drawn by lot at the venue
 * (Reg 36), and the desk enters how the lots fell before making the draws.
 */
export function PlacementControls({ tournamentId, drawn, ready, groupCount }: { tournamentId: string; drawn: boolean; ready: boolean; groupCount: number }) {
  const [drawState, draw, drawing] = useActionState(drawPlacementAction, null);
  const [resetState, reset, resetting] = useActionState(resetPlacementAction, null);
  const lot = (name: string, first: string, second: string, at: string) => (
    <label className="flex items-center gap-2 text-xs">
      <span className="w-28 text-muted">Positions {at}</span>
      <select name={name} className="input py-1 text-xs" defaultValue="">
        <option value="">{first}, then {second}</option>
        <option value="swap">{second}, then {first}</option>
      </select>
    </label>
  );
  return (
    <div className="flex flex-wrap items-center gap-2">
      {!drawn ? (
        <form action={draw} className="space-y-2">
          <input type="hidden" name="tournament_id" value={tournamentId} />
          {groupCount === 4 && (
            <div className="grid gap-3 sm:grid-cols-2" data-testid="placement-lots">
              <div className="space-y-1">
                <p className="text-xs font-bold">Places 1–8: runners-up drawn by lot</p>
                {lot("lot_1_top", "C2", "D2", "2 and 3")}
                {lot("lot_1_bottom", "A2", "B2", "6 and 7")}
              </div>
              <div className="space-y-1">
                <p className="text-xs font-bold">Places 9–16: fourth places drawn by lot</p>
                {lot("lot_9_top", "C4", "D4", "2 and 3")}
                {lot("lot_9_bottom", "A4", "B4", "6 and 7")}
              </div>
            </div>
          )}
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

/** A tie's court and its not-before time, in the event's own time (Cairo). */
export function ScheduleForm({
  tournamentId,
  tieId,
  courts,
  courtId,
  local,
}: {
  tournamentId: string;
  tieId: string;
  courts: { id: string; name: string }[];
  courtId: string | null;
  /** The current time as Cairo's wall clock, for the input. */
  local: string;
}) {
  const [state, action, pending] = useActionState(scheduleTieAction, null);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2" data-testid="schedule-form">
      <input type="hidden" name="tournament_id" value={tournamentId} />
      <input type="hidden" name="tie_id" value={tieId} />
      <label className="text-xs">
        <span className="label">Court</span>
        <select name="court_id" className="input" defaultValue={courtId ?? ""}>
          <option value="">No court yet</option>
          {courts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs">
        <span className="label">Not before (Cairo time)</span>
        <input name="scheduled_local" type="datetime-local" className="input" defaultValue={local} />
      </label>
      <button type="submit" className="btn-secondary py-1 text-xs" disabled={pending}>Save</button>
      <Notice state={state} />
    </form>
  );
}

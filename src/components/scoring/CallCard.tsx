"use client";

/**
 * The referee's call card on the web console (plan Phase 5), the twin of the
 * Move Score app's CallCard: "Call to court", the countdown to the deadline, who
 * is at the court, and once the deadline passes with a side missing, the
 * no-show question (keep waiting / +N min up to the maximum / walkover to the
 * side that is here; both absent never offers a walkover). The model is the
 * shared callCardModel, recomputed every second with the tournament's rules;
 * every action goes through /api/matches/[matchId]/call.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { TeamKey } from "@/lib/scoring/engine";
import type { MatchDayRules } from "@/lib/matchday/rules";
import { callCardModel, type CallSnapshot, type NoShowChoice, type NoShowOption } from "@/lib/matchday/callCard";

export interface CallCardProps {
  matchId: string;
  rules: MatchDayRules;
  initialCall: CallSnapshot | null;
  matchStatus: string;
  hasCourt: boolean;
  names: Record<TeamKey, string>;
  /** This console's scoring device id: a walkover keeps the lease it holds. */
  deviceId: () => string;
  /** The answer decided the match (a walkover): the console reloads. */
  onDecided?: () => void;
}

type Body =
  | { action: "call"; force?: boolean }
  | { action: "present"; side: TeamKey }
  | { action: "extend" }
  | { action: "answer"; answer: Exclude<NoShowChoice, "extend">; deviceId?: string }
  | { action: "cancel" };

export default function CallCard({ matchId, rules, initialCall, matchStatus, hasCourt, names, deviceId, onDecided }: CallCardProps) {
  const [call, setCall] = useState<CallSnapshot | null>(initialCall);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<Body["action"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [courtBusy, setCourtBusy] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [askedFor, setAskedFor] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<NoShowOption | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const model = useMemo(() => callCardModel({ call, rules, nowMs: now, matchStatus, hasCourt, names }), [call, rules, now, matchStatus, hasCourt, names]);

  useEffect(() => {
    if (!model.show) return;
    if (model.tickMs) {
      const id = setInterval(() => setNow(Date.now()), model.tickMs);
      return () => clearInterval(id);
    }
    const next = model.view?.nextChangeAt;
    if (!next) return;
    const id = setTimeout(() => setNow(Date.now()), Math.max(250, next - Date.now()));
    return () => clearTimeout(id);
  }, [model.show, model.tickMs, model.view?.nextChangeAt]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/matches/${matchId}/call`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { call: CallSnapshot | null };
      setCall(data.call);
      setNow(Date.now());
    } catch {
      /* offline: keep counting from what we have */
    }
  }, [matchId]);

  // The page may have been rendered a moment before the call landed (auto call on open): read it once now.
  useEffect(() => {
    const id = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(id);
  }, [refresh]);

  // Players mark themselves present on their phones: look again while the call is open.
  const open = model.show && call?.status === "called";
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(id);
  }, [open, refresh]);

  // The no-show question opens on its own once per deadline.
  const asking = Boolean(model.noShow?.length);
  const deadline = call?.deadlineAt ?? null;
  const showSheet = asking && (sheet || (deadline !== null && askedFor !== deadline));

  const act = useCallback(async (body: Body): Promise<boolean> => {
    setBusy(body.action);
    setError(null);
    try {
      const res = await fetch(`/api/matches/${matchId}/call`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => null)) as { call?: CallSnapshot; matchStatus?: string; error?: string; code?: string } | null;
      if (!res.ok) {
        if (data?.code === "court_busy") setCourtBusy(data.error ?? "Another match is on this court.");
        else setError(data?.error ?? "That did not work. Try again.");
        if (data?.code === "changed" || data?.code === "no_call" || data?.code === "not_due") void refresh();
        return false;
      }
      if (data?.call) setCall(data.call);
      setNow(Date.now());
      setCourtBusy(null);
      if (data?.matchStatus && data.matchStatus !== "scheduled" && data.matchStatus !== "ready") onDecided?.();
      return true;
    } catch {
      setError("No connection. Calls and answers need the network; try again.");
      return false;
    } finally {
      setBusy(null);
    }
  }, [matchId, refresh, onDecided]);

  function closeSheet() {
    setSheet(false);
    setConfirming(null);
    if (deadline) setAskedFor(deadline);
  }

  async function pick(o: NoShowOption) {
    if (o.danger && confirming?.choice !== o.choice) {
      setConfirming(o);
      return;
    }
    const ok = o.choice === "extend" ? await act({ action: "extend" }) : await act({ action: "answer", answer: o.choice, deviceId: deviceId() });
    if (ok) closeSheet();
  }

  if (!model.show) return null;
  const isBusy = busy !== null;
  const tone = model.urgent ? "border-danger" : model.phase === "all_present" ? "border-success" : "border-border";

  return (
    <div className={`card w-full max-w-sm space-y-3 border-2 ${tone}`} data-testid="call-card">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className={`text-xs font-bold uppercase tracking-widest ${model.urgent ? "text-danger" : "text-muted"}`}>{model.title}</p>
          {model.detail && <p className="text-sm text-muted">{model.detail}</p>}
        </div>
        {model.countdown && (
          <p className={`font-mono text-4xl font-bold tabular-nums ${model.urgent ? "text-danger" : ""}`} aria-label={`${model.countdown} left`} data-testid="call-countdown">
            {model.countdown}
          </p>
        )}
      </div>

      {model.phase !== "not_called" && (
        <ul className="space-y-2">
          {model.sides.map((s) => (
            <li key={s.key} className="flex min-h-11 items-center gap-3">
              <span className={`h-2.5 w-2.5 rounded-full ${s.present ? "bg-success" : "bg-muted"}`} aria-hidden />
              <span className="flex-1 truncate font-semibold">{s.name}</span>
              {s.present ? (
                <span className="text-xs font-bold uppercase tracking-widest text-success">✓ At court</span>
              ) : s.canMark ? (
                <button type="button" className="btn-secondary min-h-11" disabled={isBusy} onClick={() => void act({ action: "present", side: s.key })} data-testid={`call-present-${s.key}`}>
                  Mark here
                </button>
              ) : (
                <span className="text-xs uppercase tracking-widest text-muted">Not here</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      )}

      {model.canCall && !courtBusy && (
        <button type="button" className="btn-primary min-h-12 w-full" disabled={isBusy} onClick={() => void act({ action: "call" })} data-testid="call-to-court">
          {busy === "call" ? "Calling…" : "Call to court"}
        </button>
      )}
      {courtBusy && (
        <div className="space-y-2" role="alert">
          <p className="text-sm text-danger">{courtBusy}</p>
          <div className="flex gap-2">
            <button type="button" className="btn-secondary min-h-11 flex-1" onClick={() => setCourtBusy(null)}>
              Not now
            </button>
            <button type="button" className="btn-danger min-h-11 flex-1" disabled={isBusy} onClick={() => void act({ action: "call", force: true })}>
              Call anyway
            </button>
          </div>
        </div>
      )}

      {asking && !showSheet && (
        <button type="button" className="btn-danger min-h-12 w-full" onClick={() => setSheet(true)}>
          Answer the no-show
        </button>
      )}

      {model.canCancel &&
        (confirmCancel ? (
          <div className="flex gap-2">
            <button type="button" className="btn-secondary min-h-11 flex-1" onClick={() => setConfirmCancel(false)}>
              Keep the call
            </button>
            <button type="button" className="btn-danger min-h-11 flex-1" disabled={isBusy} onClick={() => void act({ action: "cancel" }).then(() => setConfirmCancel(false))}>
              Withdraw it
            </button>
          </div>
        ) : (
          <button type="button" className="text-sm font-semibold text-accent" onClick={() => setConfirmCancel(true)}>
            Wrong match? Withdraw the call
          </button>
        ))}

      {showSheet && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="no-show-title" data-testid="no-show-sheet">
          <div className="card w-full max-w-sm space-y-3 bg-card">
            <h2 id="no-show-title" className="font-bold">
              {model.title}
            </h2>
            {confirming ? (
              <>
                <p className="font-semibold">{confirming.confirm}</p>
                {error && <p className="text-sm text-danger">{error}</p>}
                <button type="button" className="btn-danger min-h-12 w-full" disabled={isBusy} onClick={() => void pick(confirming)} data-testid="no-show-confirm">
                  {isBusy ? "Recording…" : "Yes, record it"}
                </button>
                <button type="button" className="btn-secondary min-h-11 w-full" disabled={isBusy} onClick={() => setConfirming(null)}>
                  Back
                </button>
              </>
            ) : (
              <>
                <p className="text-sm text-muted">{model.detail}</p>
                {model.sides
                  .filter((s) => s.canMark)
                  .map((s) => (
                    <button key={s.key} type="button" className="btn-secondary min-h-11 w-full" disabled={isBusy} onClick={() => void act({ action: "present", side: s.key }).then((ok) => ok && closeSheet())}>
                      {s.name} is here now
                    </button>
                  ))}
                {(model.noShow ?? []).map((o) => (
                  <div key={o.choice} className="space-y-1">
                    <button
                      type="button"
                      className={`${o.danger ? "btn-danger" : o.choice === "extend" ? "btn-primary" : "btn-secondary"} min-h-12 w-full`}
                      disabled={isBusy}
                      onClick={() => void pick(o)}
                      data-testid={`no-show-${o.choice}`}
                    >
                      {o.label}
                    </button>
                    <p className="text-xs text-muted">{o.detail}</p>
                  </div>
                ))}
                {error && <p className="text-sm text-danger">{error}</p>}
                <button type="button" className="text-sm font-semibold text-muted" onClick={closeSheet}>
                  Close
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

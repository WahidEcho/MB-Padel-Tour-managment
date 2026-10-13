/**
 * The referee's call to court for one match (plan Phase 5): the stored call from
 * the bootstrap, the card's model recomputed every second on this phone's clock
 * with the tournament's own match-day rules (callCardModel, shared with the web
 * console), and the actions through the call route
 * (src/app/api/matches/[matchId]/call/route.ts) with the referee's staff token.
 *
 * While the call is open it reads the call again every 10 seconds, so a player
 * marking themselves "at court" on their own phone shows here without a tap.
 * Needs signal: calling, presence and the no-show answer are decided on the
 * server, never queued.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_MATCH_DAY_RULES, OFF_MATCH_DAY_RULES, callCardModel, type CallCardModel, type NoShowChoice, type TeamKey } from "@core";
import { api, ApiError } from "../api/client";
import type { RefereeBootstrap, RefereeCall } from "./types";

export type CallBody =
  | { action: "call"; force?: boolean }
  | { action: "present"; side: TeamKey }
  | { action: "extend" }
  | { action: "answer"; answer: Exclude<NoShowChoice, "extend">; deviceId?: string }
  | { action: "cancel" };

export interface CallAnswerResult {
  call: RefereeCall;
  matchStatus?: string;
}

const POLL_MS = 10_000;

export function useCall(boot: RefereeBootstrap, opts: { deviceId: string; matchStatus: string; onMatchDecided?: () => void }) {
  const m = boot.match;
  const rules = boot.matchDay ?? (boot.call ? DEFAULT_MATCH_DAY_RULES : OFF_MATCH_DAY_RULES);
  const [call, setCall] = useState<RefereeCall | null>(boot.call ?? null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<CallBody["action"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The court is busy: calling again means calling anyway. */
  const [courtBusy, setCourtBusy] = useState<string | null>(null);
  const decided = useRef(opts.onMatchDecided);
  useEffect(() => {
    decided.current = opts.onMatchDecided;
  }, [opts.onMatchDecided]);

  // A fresh bootstrap (a refetch on focus) brings the server's call.
  useEffect(() => {
    if (boot.call !== undefined) setCall(boot.call ?? null);
  }, [boot.call]);

  const names = useMemo(() => ({ A: boot.sideA?.name ?? "Side A", B: boot.sideB?.name ?? "Side B" }), [boot.sideA?.name, boot.sideB?.name]);
  const model: CallCardModel = useMemo(
    () => callCardModel({ call, rules, nowMs: now, matchStatus: opts.matchStatus, hasCourt: Boolean(m.court_id), names }),
    [call, rules, now, opts.matchStatus, m.court_id, names],
  );

  // The countdown: every second while the call runs; otherwise only when the view next changes on its own.
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
      const r = await api<{ call: RefereeCall | null }>(`/api/matches/${m.id}/call`, { who: "staff", timeoutMs: 8_000 });
      setCall(r.call);
      setNow(Date.now());
    } catch {
      /* offline: the card keeps counting from what it has */
    }
  }, [m.id]);

  // Read the call once on opening: the bootstrap may be the one saved for offline use.
  useEffect(() => {
    const id = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(id);
  }, [refresh]);

  // Players mark themselves present on their own phones: look again while the call is open.
  const open = model.show && call?.status === "called";
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [open, refresh]);

  const act = useCallback(
    async (body: CallBody): Promise<CallAnswerResult | null> => {
      setBusy(body.action);
      setError(null);
      try {
        const r = await api<CallAnswerResult>(`/api/matches/${m.id}/call`, { who: "staff", body, timeoutMs: 15_000 });
        setCall(r.call);
        setNow(Date.now());
        setCourtBusy(null);
        if (r.matchStatus && r.matchStatus !== "scheduled" && r.matchStatus !== "ready") decided.current?.();
        return r;
      } catch (e) {
        const code = e instanceof ApiError ? (e.body as { code?: string } | null)?.code : undefined;
        if (code === "court_busy") setCourtBusy(e instanceof ApiError ? e.message : null);
        else if (e instanceof ApiError && e.status !== 0) setError(e.message);
        else setError("No signal. Calls and answers need a connection; try again.");
        // Another device moved the call on: show what it is now.
        if (code === "changed" || code === "no_call" || code === "not_due") void refresh();
        return null;
      } finally {
        setBusy(null);
      }
    },
    [m.id, refresh],
  );

  return {
    model,
    call,
    rules,
    busy,
    error,
    courtBusy,
    clearError: () => {
      setError(null);
      setCourtBusy(null);
    },
    refresh,
    callNow: (force = false) => act({ action: "call", ...(force ? { force: true } : {}) }),
    present: (side: TeamKey) => act({ action: "present", side }),
    extend: () => act({ action: "extend" }),
    answer: (answer: Exclude<NoShowChoice, "extend">) => act({ action: "answer", answer, deviceId: opts.deviceId }),
    cancel: () => act({ action: "cancel" }),
  };
}

export type CallControls = ReturnType<typeof useCall>;

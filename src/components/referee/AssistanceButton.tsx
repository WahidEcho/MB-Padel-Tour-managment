"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { closedCallShown, elapsedClock, type CallStatus, type MasterAnswerRow } from "@/lib/referees/rules";
import { callWord } from "@/lib/referees/callWords";

interface Call {
  id: string;
  court: string;
  status: CallStatus;
  acknowledgedBy: string | null;
  acknowledgedAt?: string | null;
  resolvedBy: string | null;
  resolvedAt?: string | null;
  requestedAt: string;
  // 0042 (older servers send none of these)
  going?: string | null;
  responses?: MasterAnswerRow[];
  remindersSent?: number;
  escalatedAt?: string | null;
}

const API = "/api/mobile/v1/referee/assistance";
const W = (key: Parameters<typeof callWord>[1], vars?: Record<string, string | number>) => callWord("en", key, vars);
const hhmm = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "");

/** A drawn tick, cross or dots for a master's answer (no emoji). */
function AnswerMark({ answer }: { answer: MasterAnswerRow["answer"] }) {
  const common = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (answer === "coming") return <svg {...common} className="text-success"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;
  if (answer === "declined") return <svg {...common} className="text-danger"><path d="M6 6l12 12M18 6L6 18" /></svg>;
  return <svg {...common} className="text-muted"><path d="M6 12h.01M12 12h.01M18 12h.01" /></svg>;
}

/**
 * "Call for assistance" on a court referee's console (migrations 0035 and 0042): one big
 * button, then the call's live status, polled every five seconds while the page is
 * visible: the running time and reminders while nobody has answered ("Organiser alerted"
 * after two minutes), every master on duty with their answer (Coming / Declined / No
 * answer yet), a green "Sara is coming to Court 2" once one takes it, and "Resolved by
 * Sara" (or "Call cancelled") for a minute after it closes. Repeated taps join the open
 * call (the server dedupes them).
 */
export default function AssistanceButton({
  matchId,
  compact = false,
  statusOnly = false,
}: {
  matchId?: string;
  compact?: boolean;
  /** Scoring v2: the call is made from More → "Call master referee"; here only an open call's status shows. */
  statusOnly?: boolean;
}) {
  const [call, setCall] = useState<Call | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const seenAck = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(API, { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { call?: Call | null };
      setCall(body.call ?? null);
    } catch {
      /* offline: keep what we have */
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const id = setInterval(() => document.visibilityState === "visible" && void load(), 5000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [load]);

  const open = Boolean(call && (call.status === "open" || call.status === "acknowledged"));
  // The running clock, and a closed call hiding after a minute.
  useEffect(() => {
    if (!call) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [call]);

  // The master's answer: a short vibration where the device can.
  useEffect(() => {
    if (call?.status === "acknowledged" && seenAck.current !== call.id) {
      seenAck.current = call.id;
      try {
        navigator.vibrate?.([120, 60, 120]);
      } catch {
        /* not supported */
      }
    }
  }, [call]);

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const json = (await res.json().catch(() => ({}))) as { call?: Call; error?: string };
      if (!res.ok) setError(json.error ?? "The call could not be sent. Call the desk.");
      else if (json.call) setCall(json.call);
    } catch {
      setError(W("noConnection"));
    } finally {
      setBusy(false);
    }
  };

  const closedShown = Boolean(call && !open && closedCallShown({ status: call.status, resolvedAt: call.resolvedAt ?? null }, now));
  if (statusOnly && !open && !closedShown) return null;
  const going = call?.going ?? (call?.status === "acknowledged" ? call.acknowledgedBy : null);
  const answers = call?.responses ?? [];
  const reminders = call?.remindersSent ?? 0;

  return (
    <div
      className={`rounded-2xl border ${open ? (call!.status === "acknowledged" ? "border-success/50 bg-success/10" : "border-warning/60 bg-warning/10") : "border-border bg-card"} ${compact ? "p-2" : "p-3"}`}
      data-testid="assistance"
    >
      {!open ? (
        <>
          {!statusOnly && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void post({ action: "request", matchId })}
              className={`w-full rounded-xl bg-danger font-black uppercase tracking-wide text-white active:scale-[0.99] disabled:opacity-60 ${compact ? "py-2 text-sm" : "py-4 text-lg"}`}
              data-testid="call-assistance"
            >
              {busy ? W("calling") : W("callButton")}
            </button>
          )}
          {call && closedShown && (
            <p className="mt-1 text-xs font-semibold text-muted" data-testid="assistance-resolved">
              {call.status === "resolved" ? (call.resolvedBy ? W("resolvedBy", { name: call.resolvedBy }) : W("resolved")) : W("cancelled")}
            </p>
          )}
        </>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div aria-live="polite">
              {going ? (
                <p className={`font-black text-success ${compact ? "text-sm" : "text-base"}`} data-testid="assistance-status">
                  {W("isComing", { name: going, court: call!.court })}
                </p>
              ) : (
                <p className={`font-bold text-warning ${compact ? "text-sm" : "text-base"}`} data-testid="assistance-status">
                  {W("callingNoAnswer", { clock: elapsedClock(call!.requestedAt, now) })}
                </p>
              )}
              <p className="text-xs text-muted">
                {call!.court} · {W("calledAt", { time: hhmm(call!.requestedAt) })}
                {!going && reminders > 0 ? <span data-testid="assistance-reminders"> · {reminders === 1 ? W("remindersSent") : W("remindersSentMany", { n: reminders })}</span> : null}
                {!going && call!.escalatedAt ? <span className="font-semibold text-danger" data-testid="assistance-escalated"> · {W("organiserAlerted")}</span> : null}
              </p>
            </div>
            <div className="flex gap-2">
              <button type="button" disabled={busy} onClick={() => void post({ action: "request", matchId })} className="btn-secondary text-xs" data-testid="call-again">
                {W("callAgain")}
              </button>
              {call!.status === "open" && (
                <button type="button" disabled={busy} onClick={() => void post({ action: "cancel", callId: call!.id })} className="btn-secondary text-xs" data-testid="call-cancel">
                  {W("cancel")}
                </button>
              )}
            </div>
          </div>
          {answers.length > 0 ? (
            <ul className="space-y-0.5 text-sm" data-testid="assistance-answers">
              {answers.map((a) => (
                <li key={`${a.name}-${a.answer}`} className="flex items-center gap-2" data-answer={a.answer}>
                  <AnswerMark answer={a.answer} />
                  <span className="font-semibold">{a.name}</span>
                  <span className="text-xs text-muted">
                    — {a.answer === "coming" ? W("answerComing", { time: hhmm(a.at) }) : a.answer === "declined" ? W("answerDeclined", { time: hhmm(a.at) }) : W("answerNone")}
                  </span>
                </li>
              ))}
            </ul>
          ) : call!.responses && !going ? (
            <p className="text-xs text-muted">{W("noMastersOnDuty")}</p>
          ) : null}
        </div>
      )}
      {error && <p className="mt-1 text-xs font-semibold text-danger" role="alert">{error}</p>}
    </div>
  );
}

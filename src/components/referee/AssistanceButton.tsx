"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { callStatusLine, type CallStatus } from "@/lib/referees/rules";

interface Call {
  id: string;
  court: string;
  status: CallStatus;
  acknowledgedBy: string | null;
  resolvedBy: string | null;
  requestedAt: string;
}

const API = "/api/mobile/v1/referee/assistance";

/**
 * "Call for assistance" on a court referee's console (migration 0035): one big button.
 * Every master referee on duty gets an alert; when one taps "On my way" this shows
 * their name. Repeated taps join the open call (the server dedupes them). Polls every
 * five seconds while the page is visible.
 */
export default function AssistanceButton({ matchId, compact = false }: { matchId?: string; compact?: boolean }) {
  const [call, setCall] = useState<Call | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      setError("No connection. Call the desk.");
    } finally {
      setBusy(false);
    }
  };

  const open = call && (call.status === "open" || call.status === "acknowledged");
  return (
    <div className={`rounded-2xl border ${open ? (call!.status === "acknowledged" ? "border-success/50 bg-success/10" : "border-warning/60 bg-warning/10") : "border-border bg-card"} ${compact ? "p-2" : "p-3"}`} data-testid="assistance">
      {!open ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void post({ action: "request", matchId })}
          className={`w-full rounded-xl bg-danger font-black uppercase tracking-wide text-white active:scale-[0.99] disabled:opacity-60 ${compact ? "py-2 text-sm" : "py-4 text-lg"}`}
          data-testid="call-assistance"
        >
          {busy ? "Calling…" : "🆘 Call for assistance"}
        </button>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className={`font-bold ${call!.status === "acknowledged" ? "text-success" : "text-warning"}`} data-testid="assistance-status" aria-live="polite">
              {call!.status === "acknowledged" ? "✓ " : "⏳ "}
              {callStatusLine({ status: call!.status, acknowledged_by_name: call!.acknowledgedBy, resolved_by_name: call!.resolvedBy })}
            </p>
            <p className="text-xs text-muted">{call!.court} · called {new Date(call!.requestedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</p>
          </div>
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={() => void post({ action: "request", matchId })} className="btn-secondary text-xs" data-testid="call-again">
              Call again
            </button>
            {call!.status === "open" && (
              <button type="button" disabled={busy} onClick={() => void post({ action: "cancel", callId: call!.id })} className="btn-secondary text-xs" data-testid="call-cancel">
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
      {call && !open && call.status === "resolved" && <p className="mt-1 text-xs text-muted" data-testid="assistance-resolved">Last call: {callStatusLine({ status: call.status, resolved_by_name: call.resolvedBy })}</p>}
      {error && <p className="mt-1 text-xs font-semibold text-danger" role="alert">{error}</p>}
    </div>
  );
}

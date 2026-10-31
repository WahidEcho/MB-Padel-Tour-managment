"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CallAnswer, CallStatus, MasterAnswerRow } from "@/lib/referees/rules";
import { callWord, reasonText } from "@/lib/referees/callWords";

interface Call {
  id: string;
  court: string;
  tournamentId: string | null;
  matchId: string | null;
  status: CallStatus;
  requestedBy: string;
  requestedAt: string;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  // 0042 (older servers send none of these)
  going?: string | null;
  responses?: MasterAnswerRow[];
  mine?: CallAnswer | null;
  escalatedAt?: string | null;
  // 0044
  reason?: string | null;
}

const API = "/api/mobile/v1/referee/assistance";
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "—");

/** A short two-tone alarm (Web Audio). Browsers allow sound only after a tap on the page. */
function alarm(ctx: AudioContext | null) {
  if (!ctx) return;
  const now = ctx.currentTime;
  for (const [i, f] of [880, 660, 880, 660].entries()) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = f;
    o.type = "square";
    g.gain.setValueAtTime(0.0001, now + i * 0.22);
    g.gain.exponentialRampToValueAtTime(0.25, now + i * 0.22 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.22 + 0.2);
    o.connect(g).connect(ctx.destination);
    o.start(now + i * 0.22);
    o.stop(now + i * 0.22 + 0.21);
  }
}

/**
 * The master referee's calls for assistance (migration 0035): a live banner (sound and
 * vibration on every new call) with "On my way" and "Resolved". `banner`: only the open
 * calls, for the top of every referee page; otherwise the full list with recent ones.
 */
export default function MasterCalls({ banner = false }: { banner?: boolean }) {
  const [open, setOpen] = useState<Call[]>([]);
  const [recent, setRecent] = useState<Call[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sound, setSound] = useState(false);
  const ctx = useRef<AudioContext | null>(null);
  const known = useRef<Set<string> | null>(null);
  const pathname = usePathname();

  const load = useCallback(async () => {
    try {
      const res = await fetch(API, { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { role?: string; open?: Call[]; recent?: Call[] };
      if (body.role !== "master" && body.role !== "organiser") return;
      const list = body.open ?? [];
      // A new open call since the last look: sound and vibration.
      const fresh = list.filter((c) => c.status === "open" && c.mine !== "declined" && known.current && !known.current.has(c.id));
      if (fresh.length) {
        alarm(ctx.current);
        try {
          navigator.vibrate?.([300, 120, 300, 120, 300]);
        } catch {
          /* not supported */
        }
      }
      known.current = new Set(list.map((c) => c.id));
      setOpen(list);
      setRecent(body.recent ?? []);
    } catch {
      /* offline */
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const id = setInterval(() => document.visibilityState === "visible" && void load(), 4000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [load]);

  const act = async (callId: string, body: { action: "respond"; answer: CallAnswer } | { action: "resolve" }) => {
    setError(null);
    const res = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, callId }) });
    if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Not saved.");
    await load();
  };

  const enableSound = () => {
    try {
      ctx.current ??= new AudioContext();
      void ctx.current.resume();
      setSound(true);
      alarm(ctx.current);
    } catch {
      setSound(false);
    }
  };

  // The master page lists the calls itself: no banner on top of it.
  if (banner && (open.length === 0 || pathname === "/referee/master")) return null;
  return (
    <section className={banner ? "space-y-2" : "space-y-3"} data-testid={banner ? "assistance-banner" : "master-calls"}>
      {!banner && (
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-bold">Calls for assistance</h2>
          {!sound && (
            <button type="button" onClick={enableSound} className="btn-secondary text-xs" data-testid="enable-sound">
              🔔 Turn on the alarm sound
            </button>
          )}
        </div>
      )}
      {open.map((c) => (
        <div
          key={c.id}
          className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-3 ${c.status === "open" ? "animate-pulse border-danger bg-danger/15" : "border-warning/60 bg-warning/10"}`}
          data-testid="open-call"
          data-call-id={c.id}
        >
          <div>
            <p className="text-base font-black">
              {c.status === "open" ? "🆘 " : "🏃 "}Chair umpire {c.requestedBy} is calling for assistance at {c.court}
            </p>
            {c.reason && (
              <p className="text-sm font-black text-danger" data-testid="call-reason">
                {reasonText("en", c.reason)}
              </p>
            )}
            {c.status === "acknowledged" && (
              <p className="text-sm font-bold text-success" data-testid="call-going">
                {callWord("en", "goingDesk", { name: c.going ?? c.acknowledgedBy ?? "A master referee", court: c.court })}
              </p>
            )}
            {c.status === "open" && c.mine === "declined" && (
              <p className="text-sm font-semibold text-muted" data-testid="call-mine">
                {callWord("en", "youDeclined")}
              </p>
            )}
            {(c.responses ?? []).some((r) => r.answer === "declined") && (
              <p className="text-xs text-muted">
                {callWord("en", "declinedList", { names: (c.responses ?? []).filter((r) => r.answer === "declined").map((r) => r.name).join(", ") })}
              </p>
            )}
            <p className="text-xs text-muted">
              Called {time(c.requestedAt)}
              {c.status === "acknowledged" ? ` · ${c.acknowledgedBy} on the way since ${time(c.acknowledgedAt)}` : ""}
              {c.status === "open" && c.escalatedAt ? ` · ${callWord("en", "organiserAlerted")}` : ""}
              {c.matchId ? (
                <>
                  {" · "}
                  <Link href={`/referee/matches/${c.matchId}/score`} className="underline">open the match</Link>
                </>
              ) : null}
            </p>
          </div>
          <div className="flex gap-2">
            {c.status === "open" && (
              <>
                <button type="button" onClick={() => void act(c.id, { action: "respond", answer: "coming" })} className="btn-primary px-6 py-3 text-base" data-testid="on-my-way">
                  {callWord("en", "coming")}
                </button>
                {c.mine !== "declined" && (
                  <button type="button" onClick={() => void act(c.id, { action: "respond", answer: "declined" })} className="btn-secondary px-6 py-3 text-base" data-testid="decline-call">
                    {callWord("en", "decline")}
                  </button>
                )}
              </>
            )}
            <button type="button" onClick={() => void act(c.id, { action: "resolve" })} className="btn-secondary" data-testid="resolve-call">
              {callWord("en", "resolve")}
            </button>
          </div>
        </div>
      ))}
      {!banner && open.length === 0 && <p className="card p-4 text-center text-sm text-muted">No court is calling right now.</p>}
      {!banner && recent.length > 0 && (
        <div className="space-y-1">
          <h3 className="label">Closed in the last half hour</h3>
          {recent.map((c) => (
            <p key={c.id} className="text-xs text-muted">
              {c.court} · {c.requestedBy} · called {time(c.requestedAt)} · {c.status === "resolved" ? `resolved by ${c.resolvedBy ?? "—"} at ${time(c.resolvedAt)}` : "cancelled"}
            </p>
          ))}
        </div>
      )}
      {error && <p className="text-xs font-semibold text-danger" role="alert">{error}</p>}
    </section>
  );
}

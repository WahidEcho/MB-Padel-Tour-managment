"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { pumpAction } from "../actions";

/**
 * While an announcement is sending and this page is open, the page itself sends
 * it, one time-boxed chunk per call, refreshing the figures after each. Closing
 * the page is fine: the cron drain carries on every minute.
 */
export default function Progress({ id, pending }: { id: string; pending: number }) {
  const router = useRouter();
  const [remaining, setRemaining] = useState(pending);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    (async () => {
      for (let i = 0; i < 200 && alive.current; i++) {
        try {
          const r = await pumpAction(id);
          if (!alive.current) return;
          setRemaining(r.remaining);
          setError(null);
          router.refresh();
          if (r.status !== "sending") return;
          // Nothing claimable right now (retry back-off or another drain at work): wait a little.
          await new Promise((res) => setTimeout(res, r.remaining ? 2500 : 1000));
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          await new Promise((res) => setTimeout(res, 5000));
        }
      }
    })();
    return () => {
      alive.current = false;
    };
  }, [id, router]);

  return (
    <div className="card border-accent/40 text-sm" data-testid="progress">
      <p className="font-semibold text-accent">Sending… {remaining} left</p>
      <p className="text-xs text-muted">Keep this page open to send faster; otherwise it continues in the background every minute.</p>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

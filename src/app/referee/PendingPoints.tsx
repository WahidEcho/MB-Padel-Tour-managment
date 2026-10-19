"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { pendingMatchIds, sendPendingNow } from "@/lib/offline/pending";

/** Points this browser has not sent yet: Send now, or open the match. */
export default function PendingPoints() {
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    void pendingMatchIds().then(setIds);
  }, []);
  if (!ids.length) return null;
  const send = async () => {
    setBusy(true);
    setNote(null);
    const r = await sendPendingNow();
    setIds(r.left);
    setNote(r.left.length ? "Some points could not be sent. Open the match to send them." : "Sent.");
    setBusy(false);
  };
  return (
    <div className="rounded-xl border border-warning/50 bg-warning/10 p-3 text-sm" data-testid="pending-points">
      <p className="font-semibold">Points waiting to send ({ids.length === 1 ? "1 match" : `${ids.length} matches`})</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className="btn-primary text-xs" disabled={busy} onClick={() => void send()}>
          {busy ? "Sending…" : "Send now"}
        </button>
        {ids.map((id) => (
          <Link key={id} href={`/referee/matches/${id}/score`} className="btn-secondary text-xs">
            Open that match
          </Link>
        ))}
      </div>
      {note && <p className="mt-2 text-xs text-muted">{note}</p>}
    </div>
  );
}

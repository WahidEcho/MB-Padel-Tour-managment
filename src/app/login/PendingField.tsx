"use client";

import { useEffect, useState } from "react";
import { openMatchIds, pendingMatchIds } from "@/lib/offline/pending";

/**
 * The matches this browser still holds unsent points of, or has unfinished, posted
 * with the event code: when the new code does not reach them (switching courts),
 * the old court's code keeps reaching just those matches (src/lib/auth/staff.ts
 * issueCarry). Switching is never blocked.
 */
export default function PendingField() {
  const [ids, setIds] = useState<{ pending: string[]; open: string[] }>({ pending: [], open: [] });
  useEffect(() => {
    void Promise.all([pendingMatchIds(), openMatchIds()]).then(([pending, open]) => setIds({ pending, open }));
  }, []);
  return (
    <>
      <input type="hidden" name="pending" value={ids.pending.join(",")} />
      <input type="hidden" name="open" value={ids.open.join(",")} />
      {ids.pending.length > 0 && (
        <p className="text-xs text-muted" data-testid="login-pending">
          This browser still has unsent points ({ids.pending.length === 1 ? "1 match" : `${ids.pending.length} matches`}). You keep access to
          {ids.pending.length === 1 ? " that match" : " those matches"} after signing in to another court, until they are sent.
        </p>
      )}
    </>
  );
}

"use client";

import { useEffect, useState } from "react";
import s from "./tennis.module.css";

/**
 * The live score's corner QR: fans scan it in Move Score to check in to the
 * rubber on this court (it adds to the score on their event pass). The code
 * rotates every minute, so it is fetched again when it turns over; nothing shows
 * while check-in is closed or the server can't be reached.
 */
export default function CheckInQr({ matchId }: { matchId: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      let next = 30;
      try {
        const r = await fetch(`/api/matches/${matchId}/checkin-qr`, { cache: "no-store" });
        const j = (await r.json()) as { open: boolean; svg?: string; refreshInSeconds?: number };
        if (!stop) setSvg(j.open && j.svg ? j.svg : null);
        if (j.open && j.refreshInSeconds) next = j.refreshInSeconds + 1;
      } catch {
        // Offline for a moment: keep the last code (it stays valid for a minute more).
      }
      if (!stop) timer = setTimeout(load, next * 1000);
    };
    void load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [matchId]);
  if (!svg) return null;
  return (
    <div className={s.checkin} data-testid="checkin-qr">
      <div className={s.checkinText}>
        <b>Check in</b>
        <span>Scan in Move Score</span>
      </div>
      <div className={s.checkinCode} dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}

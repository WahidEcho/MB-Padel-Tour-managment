"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RegLink } from "./RegLink";

interface Notice {
  id: string;
  at: string;
  text: string;
  court: string | null;
  regs: string[];
}

const SEEN = "ms.lineup-notices-seen";
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

function readSeen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

/**
 * The live banner of accepted line-up exceptions ("Referee Sara accepted a line-up
 * exception on Court 1: Omar plays Singles 1 above Ali (ITF Reg. 43)"), for the master
 * referees on every referee page and the organiser on every admin page. Polls the
 * staff-only notices route; "Seen" hides one on this browser (the admin log keeps it).
 */
export default function LineupNotices() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const [seen, setSeen] = useState<Set<string>>(new Set());
  const first = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/mobile/v1/referee/notices", { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { notices?: Notice[] };
      const list = body.notices ?? [];
      if (!first.current && list.some((n) => !readSeen().has(n.id))) {
        try {
          navigator.vibrate?.([200, 100, 200]);
        } catch {
          /* not supported */
        }
      }
      first.current = false;
      setNotices(list);
    } catch {
      /* offline */
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      setSeen(readSeen());
      void load();
    }, 0);
    const id = setInterval(() => document.visibilityState === "visible" && void load(), 8000);
    return () => {
      clearTimeout(t);
      clearInterval(id);
    };
  }, [load]);

  const hide = (id: string) => {
    const next = new Set(seen);
    next.add(id);
    setSeen(next);
    try {
      localStorage.setItem(SEEN, JSON.stringify([...next].slice(-200)));
    } catch {
      /* storage blocked */
    }
  };

  const open = notices.filter((n) => !seen.has(n.id));
  if (!open.length) return null;
  return (
    <section className="space-y-2" data-testid="lineup-notices">
      {open.map((n) => (
        <div key={n.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border-2 border-warning bg-warning/10 p-3 text-foreground" data-testid="lineup-notice">
          <div>
            <p className="text-sm font-bold">⚠ {n.text}</p>
            <p className="text-xs text-muted">
              {time(n.at)}
              {n.regs.map((r) => (
                <span key={r}>
                  {" · "}
                  <RegLink reg={r} />
                </span>
              ))}
            </p>
          </div>
          <button type="button" className="btn-secondary text-xs" onClick={() => hide(n.id)}>Seen</button>
        </div>
      ))}
    </section>
  );
}

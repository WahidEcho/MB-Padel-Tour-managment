"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addPlayersAction } from "../actions";

export interface PickablePlayer {
  id: string;
  name: string;
  mobile: string | null;
  level: string | null;
  inSession: boolean;
}

/**
 * Colours cycle per team, so the 1st and 2nd picks share a colour, the 3rd and
 * 4th share the next, and so on. Selection order therefore *is* the pairing —
 * no separate pairing step for the common case of "these two, then those two".
 */
const TEAM_COLORS = [
  { chip: "bg-warning/25 text-warning border-warning/50", dot: "bg-warning" },
  { chip: "bg-accent/25 text-accent border-accent/50", dot: "bg-accent" },
  { chip: "bg-success/25 text-success border-success/50", dot: "bg-success" },
  { chip: "bg-danger/25 text-danger border-danger/50", dot: "bg-danger" },
];

export default function AddPlayersDialog({
  sessionId,
  players,
  pairThem,
}: {
  sessionId: string;
  players: PickablePlayer[];
  /** Fixed-partner sessions pair by selection order; rotating ones just add. */
  pairThem: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const available = useMemo(() => players.filter((p) => !p.inSession), [players]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? available.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            (p.mobile ?? "").includes(q) ||
            (p.level ?? "").toLowerCase().includes(q)
        )
      : available;

    // Group by level so a big directory stays scannable.
    const map = new Map<string, PickablePlayer[]>();
    for (const p of matched) {
      const key = p.level ? `Level ${p.level}` : "No level set";
      map.set(key, [...(map.get(key) ?? []), p]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [available, query]);

  function toggle(id: string) {
    setError("");
    setPicked((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));
  }

  function teamIndexOf(id: string): number | null {
    const i = picked.indexOf(id);
    if (i < 0) return null;
    return Math.floor(i / 2);
  }

  function submit() {
    setError("");
    if (picked.length === 0) {
      setError("Pick at least one player.");
      return;
    }
    if (pairThem && picked.length % 2 !== 0) {
      setError("This session uses fixed partners, so pick an even number — every player needs a partner.");
      return;
    }
    startTransition(async () => {
      try {
        await addPlayersAction(sessionId, picked, pairThem);
        setPicked([]);
        setQuery("");
        setOpen(false);
        router.refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    });
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="btn-secondary text-xs">
        Add players
      </button>
    );
  }

  const teamCount = Math.ceil(picked.length / 2);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Add players to this session"
    >
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-t-[20px] bg-background sm:rounded-[20px]">
        <div className="flex items-center justify-between border-b border-border p-3">
          <h2 className="font-bold">Add players</h2>
          <button onClick={() => setOpen(false)} className="px-2 text-muted hover:text-foreground" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="border-b border-border p-3">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="input"
            placeholder="Search by name, mobile or level…"
          />
          {pairThem && (
            <p className="mt-2 text-xs text-muted">
              Tap players in pairs — each two you pick in a row become a team, shown in the same colour.
            </p>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {groups.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">
              {available.length === 0 ? "Everyone is already in this session." : "No players match that search."}
            </p>
          ) : (
            groups.map(([label, list]) => (
              <div key={label} className="mb-3">
                <p className="mb-1 text-xs font-bold uppercase text-muted">{label}</p>
                <div className="flex flex-col gap-1">
                  {list.map((p) => {
                    const team = teamIndexOf(p.id);
                    const colour = team !== null ? TEAM_COLORS[team % TEAM_COLORS.length] : null;
                    return (
                      <button
                        key={p.id}
                        onClick={() => toggle(p.id)}
                        aria-pressed={team !== null}
                        className={`flex items-center justify-between gap-2 rounded-xl border px-2 py-2 text-left text-sm transition-colors ${
                          colour ? colour.chip : "border-border bg-background hover:border-accent"
                        }`}
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-semibold">{p.name}</span>
                          {p.mobile && <span className="block font-mono text-xs opacity-70">{p.mobile}</span>}
                        </span>
                        {team !== null && pairThem && (
                          <span className="shrink-0 text-xs font-bold">Team {team + 1}</span>
                        )}
                        {team !== null && !pairThem && <span className="shrink-0 text-xs font-bold">✓</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="space-y-2 border-t border-border p-3">
          {error && (
            <p className="rounded-xl bg-danger/10 px-3 py-2 text-xs font-semibold text-danger">{error}</p>
          )}
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted">
              {picked.length} selected
              {pairThem && picked.length > 0 ? ` · ${teamCount} team${teamCount === 1 ? "" : "s"}` : ""}
            </p>
            <div className="flex gap-2">
              <button onClick={() => setPicked([])} className="btn-secondary text-xs" disabled={picked.length === 0}>
                Clear
              </button>
              <button onClick={submit} className="btn-primary text-xs" disabled={pending}>
                {pending ? "Adding…" : pairThem ? "Add & pair" : "Add to session"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

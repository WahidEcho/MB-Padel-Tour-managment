"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { savePairsAction } from "../actions";

export interface PlayerLite {
  id: string;
  name: string;
}

/** Two slots per pair; null means the slot is empty. */
type Couple = [string | null, string | null];

const UNASSIGNED = "unassigned";

function PlayerChip({ player, disabled }: { player: PlayerLite; disabled: boolean }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: player.id,
    disabled,
  });
  return (
    <div
      ref={setNodeRef}
      style={transform ? { transform: `translate(${transform.x}px, ${transform.y}px)`, zIndex: 50 } : undefined}
      className={`flex items-center gap-1 rounded-xl border border-border bg-background px-2 py-1.5 text-sm ${
        isDragging ? "opacity-70 shadow-lg" : ""
      }`}
    >
      <button
        className={`touch-none px-1 ${disabled ? "cursor-not-allowed text-muted" : "cursor-grab"}`}
        {...listeners}
        {...attributes}
        aria-label={`Drag ${player.name}`}
      >
        ⠿
      </button>
      <span className="truncate font-semibold">{player.name}</span>
    </div>
  );
}

function Slot({
  id,
  children,
  label,
}: {
  id: string;
  children: React.ReactNode;
  label: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={`min-h-11 rounded-xl border border-dashed p-1 ${
        isOver ? "border-accent bg-accent/10" : "border-border"
      }`}
      aria-label={label}
    >
      {children ?? <p className="px-2 py-1 text-xs text-muted">{label}</p>}
    </div>
  );
}

export default function PairsClient({
  sessionId,
  players,
  initialCouples,
  locked,
}: {
  sessionId: string;
  players: PlayerLite[];
  initialCouples: Couple[];
  locked: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");

  // Always keep one empty pair at the end so there is somewhere to drop.
  const withSpare = (list: Couple[]): Couple[] => {
    const trimmed = list.filter((c) => c[0] || c[1]);
    return [...trimmed, [null, null] as Couple];
  };
  const [couples, setCouples] = useState<Couple[]>(withSpare(initialCouples));

  const assigned = new Set(couples.flat().filter(Boolean) as string[]);
  const unassigned = players.filter((p) => !assigned.has(p.id));
  const byId = new Map(players.map((p) => [p.id, p]));

  function handleDragEnd(e: DragEndEvent) {
    if (locked) return;
    const playerId = String(e.active.id);
    const target = e.over ? String(e.over.id) : null;
    if (!target) return;

    setCouples((prev) => {
      // Remove the player from wherever they are.
      const next = prev.map((c) => c.map((p) => (p === playerId ? null : p)) as Couple);

      if (target !== UNASSIGNED) {
        const [idxRaw, slotRaw] = target.split(":");
        const idx = Number(idxRaw);
        const slot = Number(slotRaw) as 0 | 1;
        if (Number.isFinite(idx) && next[idx]) {
          // Whoever was here goes back to the pool rather than vanishing.
          next[idx][slot] = playerId;
        }
      }
      return withSpare(next);
    });
  }

  function save() {
    setError("");
    const complete = couples.filter((c) => c[0] && c[1]) as [string, string][];
    const halfFilled = couples.filter((c) => (c[0] && !c[1]) || (!c[0] && c[1]));
    if (halfFilled.length > 0) {
      setError("Every pair needs two players. Complete or clear the half-filled pairs.");
      return;
    }
    if (complete.length < 2) {
      setError("At least 2 complete pairs are needed.");
      return;
    }
    startTransition(async () => {
      try {
        await savePairsAction(sessionId, complete);
        router.refresh();
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 8 } })
  );

  if (locked) {
    return (
      <p className="rounded-xl bg-warning/10 px-3 py-2 text-xs font-semibold text-warning">
        Matches have started, so pairs are locked. Void the remaining matches to rebuild them.
      </p>
    );
  }

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="space-y-3">
        <div>
          <p className="mb-1 text-xs font-bold uppercase text-muted">
            Unassigned ({unassigned.length})
          </p>
          <Slot id={UNASSIGNED} label="Drag players here to unassign">
            {unassigned.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {unassigned.map((p) => (
                  <PlayerChip key={p.id} player={p} disabled={false} />
                ))}
              </div>
            ) : null}
          </Slot>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {couples.map((couple, idx) => (
            <div key={idx} className="rounded-xl border border-border bg-background p-2">
              <p className="mb-1 text-xs font-bold uppercase text-muted">Pair {idx + 1}</p>
              <div className="space-y-1">
                {[0, 1].map((slot) => {
                  const pid = couple[slot];
                  const player = pid ? byId.get(pid) : undefined;
                  return (
                    <Slot key={slot} id={`${idx}:${slot}`} label={`Player ${slot + 1}`}>
                      {player ? <PlayerChip player={player} disabled={false} /> : null}
                    </Slot>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {error && (
          <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm font-semibold text-danger">{error}</p>
        )}

        <button onClick={save} disabled={pending} className="btn-primary text-sm">
          {pending ? "Saving…" : "Save pairs"}
        </button>
      </div>
    </DndContext>
  );
}

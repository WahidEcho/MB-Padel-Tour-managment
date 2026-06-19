"use client";

import { useRef, useState } from "react";
import ChessBoard from "./ChessBoard";

function PlayerPanel({
  color,
  name,
  active,
  won,
}: {
  color: "white" | "black";
  name: string;
  active: boolean;
  won: boolean;
}) {
  return (
    <div
      className={`flex flex-1 items-center justify-center gap-2 rounded-xl border-2 px-3 py-2 text-center ${
        active ? "border-accent bg-accent/10" : won ? "border-success bg-success/10" : "border-border bg-card"
      }`}
    >
      <span className="text-xl">{color === "white" ? "○" : "●"}</span>
      <span className="min-w-0">
        <span className="block truncate text-lg font-bold sm:text-2xl">{name}</span>
        <span className="block text-[10px] uppercase tracking-widest text-muted">
          {color}
          {active ? " · to move" : ""}
          {won ? " · winner 🏆" : ""}
        </span>
      </span>
    </div>
  );
}

export default function ChessTheater({
  fen,
  movePairs,
  whiteName,
  blackName,
  toMove,
  inCheck,
  winnerColor,
  score,
  heading,
  status,
}: {
  fen: string;
  movePairs: string[];
  whiteName: string;
  blackName: string;
  toMove: "white" | "black" | null;
  inCheck: boolean;
  winnerColor: "white" | "black" | null;
  score: string;
  heading: string;
  status: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [isFull, setIsFull] = useState(false);

  async function toggleFullscreen() {
    const el = ref.current;
    if (!el) return;
    try {
      if (!document.fullscreenElement) {
        await el.requestFullscreen();
        setIsFull(true);
      } else {
        await document.exitFullscreen();
        setIsFull(false);
      }
    } catch {
      /* fullscreen not available — theater layout still applies */
    }
  }

  return (
    <div ref={ref} className="theme-dark flex min-h-[80vh] flex-col gap-3 bg-background p-3 text-foreground">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold">{heading}</p>
          <p className="text-xs capitalize text-muted">
            ♟ {status.replace("_", " ")}
            {inCheck && toMove ? " · CHECK" : ""}
            {score ? ` · ${score}` : ""}
          </p>
        </div>
        <button onClick={toggleFullscreen} className="btn-secondary text-xs">
          {isFull ? "Exit full screen" : "⛶ Full screen"}
        </button>
      </div>

      <div className="flex gap-2">
        <PlayerPanel color="white" name={whiteName} active={toMove === "white"} won={winnerColor === "white"} />
        <PlayerPanel color="black" name={blackName} active={toMove === "black"} won={winnerColor === "black"} />
      </div>

      <div className="mx-auto w-full max-w-[min(80vh,600px)]">
        <ChessBoard fen={fen} readOnly showCoords />
      </div>

      <div className="rounded-xl bg-card p-3">
        <p className="mb-1 text-[10px] uppercase tracking-widest text-muted">Move log</p>
        <div className="max-h-40 overflow-y-auto">
          <p className="break-words font-mono text-sm leading-relaxed">
            {movePairs.length > 0 ? movePairs.join("   ") : <span className="text-muted">No moves yet</span>}
          </p>
        </div>
      </div>
    </div>
  );
}

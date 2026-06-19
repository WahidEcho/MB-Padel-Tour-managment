"use client";

import { useMemo, useState } from "react";
import { Chess, type Square } from "chess.js";

const GLYPH: Record<string, string> = {
  wK: "♔", wQ: "♕", wR: "♖", wB: "♗", wN: "♘", wP: "♙",
  bK: "♚", bQ: "♛", bR: "♜", bB: "♝", bN: "♞", bP: "♟",
};

const LIGHT = "#e9edcc";
const DARK = "#6b9b5f";
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];

type Promo = "q" | "r" | "b" | "n";

export default function ChessBoard({
  fen,
  onMove,
  readOnly = false,
  showCoords = false,
  lastMove,
}: {
  fen: string;
  onMove?: (from: string, to: string, promotion?: Promo) => void;
  readOnly?: boolean;
  showCoords?: boolean;
  lastMove?: { from: string; to: string } | null;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [pendingPromo, setPendingPromo] = useState<{ from: string; to: string } | null>(null);

  const chess = useMemo(() => {
    try {
      return new Chess(fen);
    } catch {
      return new Chess();
    }
  }, [fen]);

  const board = chess.board(); // rank 8 → rank 1
  const turnColor = chess.turn(); // "w" | "b"
  const interactive = !readOnly && Boolean(onMove);

  const targets = useMemo(() => {
    if (!selected || !interactive) return new Map<string, boolean>();
    const verbose = chess.moves({ square: selected as Square, verbose: true }) as Array<{
      to: string;
      promotion?: string;
    }>;
    const m = new Map<string, boolean>();
    for (const v of verbose) m.set(v.to, m.get(v.to) || Boolean(v.promotion));
    return m;
  }, [selected, interactive, chess]);

  function squareName(rankIdx: number, fileIdx: number): string {
    return `${FILES[fileIdx]}${8 - rankIdx}`;
  }

  function handleClick(sq: string) {
    if (!interactive) return;
    const piece = chess.get(sq as Square);
    if (selected) {
      if (sq === selected) {
        setSelected(null);
        return;
      }
      if (targets.has(sq)) {
        if (targets.get(sq)) {
          setPendingPromo({ from: selected, to: sq });
        } else {
          onMove!(selected, sq);
          setSelected(null);
        }
        return;
      }
      // Clicked a different own piece → reselect; otherwise clear.
      if (piece && piece.color === turnColor) setSelected(sq);
      else setSelected(null);
      return;
    }
    if (piece && piece.color === turnColor) setSelected(sq);
  }

  function choosePromo(p: Promo) {
    if (pendingPromo) {
      onMove!(pendingPromo.from, pendingPromo.to, p);
      setPendingPromo(null);
      setSelected(null);
    }
  }

  return (
    <div className="relative w-full" style={{ containerType: "inline-size" }}>
      <div className="grid grid-cols-8 overflow-hidden rounded-lg ring-1 ring-black/20">
        {board.map((row, rankIdx) =>
          row.map((cell, fileIdx) => {
            const sq = squareName(rankIdx, fileIdx);
            const isLight = (rankIdx + fileIdx) % 2 === 0;
            const isSel = selected === sq;
            const isTarget = targets.has(sq);
            const isLast = lastMove && (lastMove.from === sq || lastMove.to === sq);
            return (
              <button
                key={sq}
                type="button"
                onClick={() => handleClick(sq)}
                disabled={!interactive}
                aria-label={sq}
                className="relative flex aspect-square items-center justify-center select-none"
                style={{
                  background: isLight ? LIGHT : DARK,
                  cursor: interactive ? "pointer" : "default",
                }}
              >
                {isLast && <span className="absolute inset-0 bg-yellow-300/35" />}
                {isSel && <span className="absolute inset-0 bg-sky-400/45" />}
                {isTarget && !cell && (
                  <span className="absolute h-[28%] w-[28%] rounded-full bg-black/30" />
                )}
                {isTarget && cell && (
                  <span className="absolute inset-[6%] rounded-full ring-4 ring-black/30" />
                )}
                {cell && (
                  <span
                    className="relative leading-none"
                    style={{
                      fontSize: "clamp(0.8rem, 10.5cqw, 4rem)",
                      color: cell.color === "w" ? "#fff" : "#111",
                      textShadow:
                        cell.color === "w"
                          ? "0 1px 1px rgba(0,0,0,.5)"
                          : "0 1px 1px rgba(255,255,255,.25)",
                    }}
                  >
                    {GLYPH[`${cell.color}${cell.type.toUpperCase()}`]}
                  </span>
                )}
                {showCoords && fileIdx === 0 && (
                  <span className="absolute left-0.5 top-0 text-[8px] font-bold opacity-50">
                    {8 - rankIdx}
                  </span>
                )}
                {showCoords && rankIdx === 7 && (
                  <span className="absolute bottom-0 right-0.5 text-[8px] font-bold opacity-50">
                    {FILES[fileIdx]}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>

      {pendingPromo && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60">
          <div className="flex gap-2 rounded-xl bg-card p-3">
            {(["q", "r", "b", "n"] as Promo[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => choosePromo(p)}
                className="flex h-12 w-12 items-center justify-center rounded-lg bg-background text-3xl hover:bg-accent/20"
                style={{ color: turnColor === "w" ? "#fff" : "#111", background: turnColor === "w" ? "#444" : "#ccc" }}
              >
                {GLYPH[`${turnColor}${p.toUpperCase()}`]}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

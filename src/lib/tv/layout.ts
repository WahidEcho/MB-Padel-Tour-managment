/**
 * The layout budget for the venue screen, in canvas pixels.
 *
 * Everything is sized from one number: on a 65-inch 16:9 panel at 1920x1080 a
 * CSS pixel is 0.75mm, and at a 6-metre viewing distance text below about 22px is
 * decoration rather than information. Rows are pinned, not flexed — a portrait in
 * an auto-sized row once overflowed a sponsor ticker and cut players' chins off
 * on a real LED wall.
 *
 * Pure and framework-free.
 */

export const STAGE = { width: 1920, height: 1080 } as const;
export const ROWS = { header: 96, content: 900, ticker: 84 } as const;
export const GUTTER = 20;
export const MIN_TEXT = 22;

/** How much room each court gets, which decides how much it can show. */
export type Density = "hero" | "wide" | "grid" | "dense";

export interface GridPlan {
  density: Density;
  columns: number;
  rows: number;
  cardWidth: number;
  cardHeight: number;
  /** Cells left over, for standings or the next fixture. */
  spareCells: number;
}

/**
 * How a given number of courts is laid out.
 *
 *   1 court   one hero card
 *   2 courts  two wide cards side by side
 *   3-4       a 2x2 grid; with three, the fourth cell is spare
 *   5-6       a 3x2 grid, and the cards drop to scoreboard density
 *
 * Four courts is the design target: four cards of 930x420, every one fully
 * visible, nothing scrolled or clipped.
 */
export function planGrid(courtCount: number): GridPlan {
  const n = Math.max(1, courtCount);
  const shape =
    n === 1 ? { columns: 1, rows: 1, density: "hero" as const } :
    n === 2 ? { columns: 2, rows: 1, density: "wide" as const } :
    n <= 4 ? { columns: 2, rows: 2, density: "grid" as const } :
    { columns: 3, rows: Math.ceil(n / 3), density: "dense" as const };

  const width = STAGE.width - GUTTER * 2;
  const height = ROWS.content - GUTTER;
  const cardWidth = Math.floor((width - GUTTER * (shape.columns - 1)) / shape.columns);
  const cardHeight = Math.floor((height - GUTTER * (shape.rows - 1)) / shape.rows);

  return {
    ...shape,
    cardWidth,
    cardHeight,
    spareCells: shape.columns * shape.rows - n,
  };
}

/** Type sizes per density. None falls below the legibility floor. */
export const TYPE: Record<Density, { points: number; games: number; team: number; player: number; photo: number }> = {
  hero: { points: 220, games: 110, team: 64, player: 40, photo: 260 },
  wide: { points: 150, games: 80, team: 48, player: 30, photo: 180 },
  grid: { points: 96, games: 52, team: 34, player: 24, photo: 128 },
  dense: { points: 64, games: 40, team: 26, player: 22, photo: 0 },
};

/**
 * What a card leaves out as it shrinks. Never dropped at any size: the court
 * name, both team names, points, games, sets, the serve or tie-break indicator,
 * and the match status.
 */
export function showsAt(density: Density): {
  photos: boolean;
  entrance: boolean;
  resultAnimation: boolean;
  fullNames: boolean;
} {
  return {
    photos: density !== "dense",
    entrance: density !== "dense",
    resultAnimation: density !== "dense",
    fullNames: density === "hero" || density === "wide",
  };
}

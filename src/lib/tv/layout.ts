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
 * Whether a card has the height to stack a team over its photos rather than
 * squeeze everything onto one line.
 *
 * One court fills the stage and two take half of it each, so both are 880 tall
 * and were showing two thin strips of content with 300 pixels of nothing above
 * and below. Four or six courts share the height and genuinely need the row.
 */
export function isTall(density: Density): boolean {
  return density === "hero" || density === "wide";
}

/**
 * Width a run of digits needs, at a given size, in the numeral face.
 *
 * The scoreboard used fixed pixel widths — 150 for the points — with the box
 * clipping whatever did not fit. At 150px type a two-digit "30" is 186 pixels
 * wide, so every tie-break and every 30 on a two-court wall was shown with its
 * right-hand side sliced off. Nothing on a scoreboard may be cut, so the box is
 * sized from what goes in it.
 */
export function numeralWidth(digits: number, fontPx: number): number {
  return Math.ceil(Math.max(1, digits) * fontPx * 0.66);
}

/**
 * The largest size, no bigger than `basePx`, at which `text` fits `widthPx` on
 * one line — down to the legibility floor, below which it is better to let a
 * long name wrap than to shrink it into decoration.
 *
 * A rough average width per character (bold sans sits near 0.52em) rather than a
 * measurement: this runs during render on a screen that must never reflow, and
 * being a little conservative only costs a point or two of size.
 */
export function fitFontSize(text: string, widthPx: number, basePx: number, minPx = MIN_TEXT): number {
  const chars = Math.max(1, text.trim().length);
  const fits = widthPx / (chars * 0.52);
  return Math.max(minPx, Math.min(basePx, Math.floor(fits)));
}

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

/* ------------------------------------------------------------------ */
/* The leaderboard scene                                               */
/* ------------------------------------------------------------------ */

export interface LeaderboardPlan {
  columns: number;
  rows: number;
  cardWidth: number;
  cardHeight: number;
  /** Type size for every table, so they read as one set rather than a jumble. */
  fontPx: number;
  /** Whether there is room for set and game columns beside the core ones. */
  detail: boolean;
}

/** Below this the standings are a texture on a wall, not a table anybody reads. */
export const LEADERBOARD_MIN_PX = 18;
export const LEADERBOARD_MAX_PX = 44;

/**
 * How big the venue leaderboard's tables may be, from how many there are and how
 * many teams the biggest holds.
 *
 * One size for every table: the eye reads a wall of tables as a set, and three
 * groups at three sizes look like a mistake rather than a hierarchy. The size is
 * whichever of height and width runs out first, so nothing is ever clipped — the
 * old scene hard-coded 24px on a table that then forced its own 14px and the far
 * end of a room could read none of it.
 */
export function leaderboardPlan(rowCounts: number[]): LeaderboardPlan {
  const n = Math.max(1, rowCounts.length);
  const columns = n === 1 ? 1 : n <= 4 ? 2 : 3;
  const rows = Math.ceil(n / columns);
  const cardWidth = Math.floor((STAGE.width - GUTTER * 2 - GUTTER * (columns - 1)) / columns);
  const cardHeight = Math.floor((ROWS.content - GUTTER - GUTTER * (rows - 1)) / rows);

  const tallest = Math.max(1, ...rowCounts);
  // A card holds its padding, a heading, a column header and one row per team,
  // each measured in multiples of its own type size. A row is budgeted at three
  // lines rather than two: a team name is allowed to wrap rather than be cut,
  // and both players' names sit under it. Budgeting two clipped the last team of
  // every three-team group off the bottom of its card.
  const byHeight = (cardHeight - 44) / (1.7 + 1.8 + tallest * 3.1);
  // Eleven columns with detail, seven without — and the team column carries a
  // name and both players, so it is worth about half the table on its own.
  // Only a table with the whole stage to itself has room for the set and game
  // columns; below that they squeeze the name into three wrapped lines, and on a
  // wall the place, the points and the status are what anybody reads.
  const detail = cardWidth >= 1200;
  const byWidth = (cardWidth - 44) / (detail ? 30 : 20);

  const fontPx = Math.round(
    Math.max(LEADERBOARD_MIN_PX, Math.min(LEADERBOARD_MAX_PX, Math.min(byHeight, byWidth))),
  );
  return { columns, rows, cardWidth, cardHeight, fontPx, detail };
}

/* ------------------------------------------------------------------ */
/* The bracket scene                                                   */
/* ------------------------------------------------------------------ */

/**
 * Type size for a knockout tree on a wall.
 *
 * The scene had two sizes, `big` and not, and chose between them by counting
 * brackets — so publishing a Plate silently dropped the Cup from 20px to 14px,
 * both of which are under the legibility floor anyway. Size comes from the room
 * a tree actually has: its column width and how many first-round pairs must
 * stack down the height.
 *
 * The floor is lower here than elsewhere on the stage. A sixteen-team draw on
 * half a wall cannot be read from six metres at any size, and showing all of it
 * small is more use than showing half of it large.
 */
export function bracketFontPx(roundCount: number, firstRoundPairs: number, width: number, height: number): number {
  const column = width / Math.max(1, roundCount);
  // A team name runs to about twelve characters in the column.
  const byWidth = (column - 28) / (12 * 0.52);
  // A pair is its two rows, the card's padding and the gap to the next.
  const byHeight = (height - 48) / Math.max(1, firstRoundPairs) / 6;
  return Math.round(Math.max(14, Math.min(40, Math.min(byWidth, byHeight))));
}

/** Story headlines: big words sized so no word ever breaks across lines. Pure (tested in headline.test.ts). */

/** Advance widths (em) of Archivo Expanded Black capitals, read from assets/fonts/Archivo-ExpandedBlack.ttf. */
const DISPLAY_EM: Record<string, number> = {
  A: 0.954, B: 0.93, C: 0.939, D: 0.933, E: 0.86, F: 0.807, G: 1.012, H: 1.009, I: 0.395, J: 0.764, K: 0.988, L: 0.786, M: 1.178,
  N: 1.007, O: 1.008, P: 0.865, Q: 1.008, R: 0.943, S: 0.882, T: 0.877, U: 0.989, V: 0.938, W: 1.23, X: 0.961, Y: 0.966, Z: 0.877,
  "'": 0.324, "’": 0.324, " ": 0.29, "-": 0.416, ".": 0.381,
};

/** Width of an uppercased word in the display font, in em (accents share their letter's width; unknown glyphs count wide). */
export function displayWidthEm(word: string): number {
  let w = 0;
  for (const ch of word.toUpperCase()) {
    const base = ch.normalize("NFD")[0] ?? ch;
    w += DISPLAY_EM[base] ?? (/[0-9]/.test(base) ? 0.82 : 1.05);
  }
  return w;
}

/**
 * The headline's font size: as big as `max`, but small enough that its longest word fits `width` on one line,
 * so a word is never broken across lines ("COMIN / G").
 */
export function headlineSize(words: readonly string[], width: number, max: number): number {
  const widest = Math.max(0, ...words.map(displayWidthEm));
  return widest > 0 ? Math.min(max, (width * 0.96) / widest) : max;
}

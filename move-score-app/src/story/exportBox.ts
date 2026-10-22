/**
 * Where the export copy puts the sticker, and what size to ask the capture for.
 * Pure: no React Native, so it is unit-tested.
 */

export interface Pose {
  x: number;
  y: number;
  s: number;
  r: number;
}

/**
 * The box the sticker is centred in: a square centred on the sticker's point,
 * larger than the whole canvas, rotated and scaled about its centre.
 *
 * It must have room. A zero-size anchor (what the export used before) gives
 * every child an "at most 0 high" constraint: each line of text measures 0
 * high and every box without a fixed height collapses, so the scoreboard and
 * the minimal styles were captured as a thin line with a flag on it (the
 * on-screen composer measures the sticker in a full-size view, so it looked
 * right there).
 */
export function stickerBox(pose: Pose, W: number, H: number) {
  const side = 2 * Math.max(W, H);
  return {
    left: pose.x * W - side / 2,
    top: pose.y * H - side / 2,
    width: side,
    height: side,
    transform: [{ rotate: `${pose.r}rad` }, { scale: pose.s }],
  };
}

/**
 * The capture's `width`/`height` for an image `px` × `py` pixels.
 * react-native-view-shot on iOS reads them as points and draws at the screen
 * scale (1080 → 3240 px on a 3× phone, the view blown up 3×); Android and the
 * web read pixels.
 */
export function captureSize(px: number, py: number, os: string, scale: number): { width: number; height: number } {
  if (os !== "ios" || !(scale > 0)) return { width: px, height: py };
  return { width: px / scale, height: py / scale };
}

/**
 * Stage Light: the Move Score palette. A near-black floor, light that moves,
 * and one neon-yellow object, the ball. Yellow is never text on a light surface
 * (about 1.1:1 on white) and never text on the blue beam.
 *
 * Event skins recolour a tournament's own pages from two seed colours; the live
 * red, the warning amber and the yellow ball marker stay fixed so state reads
 * the same in every event.
 */
export const BALL = "#FCFC00";
export const BALL_INK = "#05060A";

export interface Palette {
  scheme: "dark" | "light";
  floor: string;
  floor2: string;
  surface: string;
  surface2: string;
  line: string;
  ink: string;
  ink2: string;
  ink3: string;
  blue: string;
  live: string;
  liveFill: string;
  warning: string;
  success: string;
  chip: string;
  btnBg: string;
  btnInk: string;
  /** Skin colours: beams, tie headers, momentum fill. */
  skinA: string;
  skinB: string;
  glowA: string;
  glowB: string;
  ball: string;
  ballInk: string;
}

export const DARK: Palette = {
  scheme: "dark",
  floor: "#00000B",
  floor2: "#01041A",
  surface: "#0A1022",
  surface2: "#111A33",
  line: "rgba(232,236,244,0.10)",
  ink: "#E8ECF4",
  ink2: "#9AA4B8",
  ink3: "#6B7590",
  blue: "#4D9BFF",
  live: "#FF2D55",
  liveFill: "#E5133A",
  warning: "#FF9F0A",
  success: "#3DDC97",
  chip: "rgba(255,255,255,0.06)",
  btnBg: BALL,
  btnInk: BALL_INK,
  skinA: "#1E6BFF",
  skinB: BALL,
  glowA: "rgba(30,107,255,0.55)",
  glowB: "rgba(252,252,0,0.32)",
  ball: BALL,
  ballInk: BALL_INK,
};

export const LIGHT: Palette = {
  scheme: "light",
  floor: "#F6F7F9",
  floor2: "#E9EDF5",
  surface: "#FFFFFF",
  surface2: "#EEF1F6",
  line: "rgba(5,6,10,0.09)",
  ink: "#05060A",
  ink2: "#4A5468",
  ink3: "#6B7590",
  blue: "#0057FF",
  live: "#E5133A",
  liveFill: "#E5133A",
  warning: "#A35A00",
  success: "#0D7A4F",
  chip: "rgba(5,6,10,0.05)",
  btnBg: BALL_INK,
  btnInk: BALL,
  skinA: "#0057FF",
  skinB: BALL,
  glowA: "rgba(0,87,255,0.22)",
  glowB: "rgba(252,252,0,0.5)",
  ball: BALL,
  ballInk: BALL_INK,
};

/* ---------------- colour maths for skins ---------------- */

type Rgb = [number, number, number];
const HEX = /^#([0-9a-f]{6})$/i;

export function hexToRgb(hex: string): Rgb | null {
  const m = HEX.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lum([r, g, b]: Rgb): number {
  const c = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}

export function contrast(a: string, b: string): number {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  if (!x || !y) return 1;
  const [l1, l2] = [lum(x), lum(y)].sort((p, q) => q - p) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [0, 1, 2].map((i) => Math.round(a[i]! + (b[i]! - a[i]!) * t)) as Rgb;
}

const toHex = (c: Rgb) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
const rgba = (c: Rgb, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

/**
 * Moves a seed colour toward white or black until it reaches `min` contrast
 * against `bg`, so a skin colour used for marks and headers stays visible on the
 * floor in both themes.
 */
export function legibleOn(seed: string, bg: string, min = 3): string {
  const s = hexToRgb(seed);
  const b = hexToRgb(bg);
  if (!s || !b) return seed;
  const towards: Rgb = lum(b) > 0.4 ? [0, 0, 0] : [255, 255, 255];
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const c = toHex(mix(s, towards, t));
    if (contrast(c, bg) >= min) return c;
  }
  return toHex(towards);
}

export interface SkinSeeds {
  seedA?: string | null;
  seedB?: string | null;
}

/** The palette inside a tournament: the base theme with the event's colours. */
export function skinned(base: Palette, skin: SkinSeeds | null | undefined): Palette {
  const a = skin?.seedA && hexToRgb(skin.seedA) ? skin.seedA : null;
  const b = skin?.seedB && hexToRgb(skin.seedB) ? skin.seedB : null;
  if (!a && !b) return base;
  const A = a ?? base.skinA;
  const B = b ?? base.skinB;
  const ra = hexToRgb(A)!;
  const rb = hexToRgb(B)!;
  const dark = base.scheme === "dark";
  return {
    ...base,
    floor2: dark ? toHex(mix(hexToRgb(base.floor2)!, ra, 0.12)) : toHex(mix(hexToRgb(base.floor2)!, ra, 0.08)),
    skinA: legibleOn(A, base.surface, 3),
    skinB: legibleOn(B, base.surface, 3),
    glowA: rgba(ra, dark ? 0.55 : 0.25),
    glowB: rgba(rb, dark ? 0.32 : 0.35),
  };
}

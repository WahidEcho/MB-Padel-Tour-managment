/**
 * Red and blue teams. When the organiser turns them on, the first-listed team of
 * every match is the Red team and the second the Blue team: the voice umpire calls
 * them by colour ("Advantage, Red team."), and the venue screens and the referee's
 * scoring page mark each side in its colour, so players and spectators hear and
 * see the same thing. Team and player names are never spoken.
 *
 * Colour is always paired with a word ("RED", "BLUE"): an LED wall's calibration
 * and a colour-blind viewer both defeat colour alone.
 */
import type { BrandingConfig } from "./types";

export type SideKey = "A" | "B";

export interface Side {
  /** Spoken and shown in full: "Red team". */
  label: string;
  /** On a chip: "RED". */
  short: string;
  /** Deep enough for white text on it (contrast above 4.5:1), bright enough on a dark wall. */
  hex: string;
}

export const SIDES: Record<SideKey, Side> = {
  A: { label: "Red team", short: "RED", hex: "#dc2626" },
  B: { label: "Blue team", short: "BLUE", hex: "#2563eb" },
};

export function redBlueTeams(branding: BrandingConfig | null | undefined): boolean {
  return branding?.redBlueTeams === true;
}

/** The side's colour at an opacity, for tinted rows and buttons. */
export function sideTint(key: SideKey, alpha: number): string {
  const hex = SIDES[key].hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(1, alpha))})`;
}

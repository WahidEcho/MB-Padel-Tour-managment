/**
 * The My matches widget's timeline: the rows as they are now, and the same rows
 * again at each upcoming start time, so WidgetKit redraws the widget (and its
 * "next match") when a match is due without the app running.
 */
import type { MWidget } from "@core";

/** WidgetKit keeps a short timeline; a handful of entries is plenty. */
export const MAX_ENTRIES = 6;

export function widgetTimeline(w: MWidget, nowMs: number): { date: Date; props: MWidget }[] {
  const starts = [...new Set(w.items.filter((m) => m.phase === "upcoming" && m.at && m.at > nowMs).map((m) => m.at!))].sort((a, b) => a - b);
  return [nowMs, ...starts].slice(0, MAX_ENTRIES).map((t) => ({ date: new Date(t), props: w }));
}

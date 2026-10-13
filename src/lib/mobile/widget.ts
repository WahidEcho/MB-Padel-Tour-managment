/**
 * The My matches widget's rows: the person's live matches first, then the next
 * ones by start time, then the ones that just finished. Built on the server
 * (GET /api/mobile/v1/me/widget) so the widget needs one small request, and the
 * phone only lays it out.
 *
 * Pure, so it is unit-tested without a database.
 */
import type { MScore, MWidgetMatch } from "./contract";

export interface WidgetSource {
  id: string;
  status: string;
  scheduledTime: string | null;
  endedAt: string | null;
  a: string;
  b: string;
  court: string;
  score: MScore | null;
  mine: boolean;
}

/** Rows the widget can show at most (the medium widget shows three). */
export const WIDGET_LIMIT = 6;
/** A finished match stays on the widget this long. */
export const WIDGET_FINAL_MS = 3 * 60 * 60_000;

const DONE = new Set(["completed", "walkover", "retired"]);
const LIVE = new Set(["live", "paused"]);

function time(t: string | null): number | null {
  if (!t) return null;
  const v = Date.parse(t);
  return Number.isFinite(v) ? v : null;
}

export function widgetItems(matches: WidgetSource[], nowMs: number, limit = WIDGET_LIMIT): MWidgetMatch[] {
  const seen = new Set<string>();
  const rows: { row: MWidgetMatch; rank: number; key: number }[] = [];
  for (const m of matches) {
    if (seen.has(m.id) || m.status === "cancelled") continue;
    seen.add(m.id);
    const at = time(m.scheduledTime);
    const phase = LIVE.has(m.status) ? "live" : DONE.has(m.status) ? "final" : "upcoming";
    const ended = time(m.endedAt) ?? at;
    if (phase === "final" && (ended === null || nowMs - ended > WIDGET_FINAL_MS)) continue;
    const s = m.score;
    const row: MWidgetMatch = {
      id: m.id,
      a: m.a || "TBD",
      b: m.b || "TBD",
      at,
      court: m.court,
      phase,
      sets: [...(s?.sets ?? []).map((x) => `${x.a}-${x.b}`), ...(phase === "live" && s?.games ? [`${s.games.a}-${s.games.b}`] : [])].join(" "),
      points: phase === "live" && s?.points ? `${s.points.a}-${s.points.b}` : "",
      mine: m.mine,
    };
    // live, then upcoming soonest first (unscheduled last), then finished most recent first
    rows.push({ row, rank: phase === "live" ? 0 : phase === "upcoming" ? 1 : 2, key: phase === "final" ? -(ended ?? 0) : at ?? Number.MAX_SAFE_INTEGER });
  }
  rows.sort((x, y) => x.rank - y.rank || x.key - y.key || x.row.id.localeCompare(y.row.id));
  return rows.slice(0, limit).map((r) => r.row);
}

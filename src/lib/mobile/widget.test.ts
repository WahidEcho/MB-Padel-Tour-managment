import { describe, expect, it } from "vitest";
import type { MScore } from "./contract";
import { WIDGET_FINAL_MS, widgetItems, type WidgetSource } from "./widget";

const NOW = Date.parse("2026-10-13T12:00:00Z");

const score: MScore = {
  sets: [{ a: 6, b: 3 }],
  games: { a: 1, b: 0 },
  points: { a: "40", b: "AD" },
  tiebreak: false,
  serving: "A",
  setsWon: { a: 1, b: 0 },
  lastEventNumber: 1,
  lastUndo: 0,
  updatedAt: null,
};

function src(id: string, over: Partial<WidgetSource> = {}): WidgetSource {
  return { id, status: "scheduled", scheduledTime: null, endedAt: null, a: "EGY", b: "TUN", court: "Court 1", score: null, mine: true, ...over };
}

describe("widgetItems", () => {
  it("orders live, then upcoming soonest first (unscheduled last), then just finished", () => {
    const rows = widgetItems(
      [
        src("later", { scheduledTime: "2026-10-13T15:00:00Z" }),
        src("none"),
        src("done", { status: "completed", endedAt: "2026-10-13T11:00:00Z", score }),
        src("soon", { scheduledTime: "2026-10-13T13:00:00Z" }),
        src("live", { status: "live", score }),
        src("old", { status: "completed", endedAt: "2026-10-13T06:00:00Z" }),
        src("cancelled", { status: "cancelled" }),
      ],
      NOW,
    );
    expect(rows.map((r) => r.id)).toEqual(["live", "soon", "later", "none", "done"]);
  });

  it("shows the live score and only finished sets afterwards", () => {
    const [live, , done] = widgetItems(
      [src("live", { status: "live", score }), src("x", { scheduledTime: "2026-10-13T13:00:00Z" }), src("done", { status: "completed", endedAt: new Date(NOW - 60_000).toISOString(), score })],
      NOW,
    );
    expect(live).toMatchObject({ phase: "live", sets: "6-3 1-0", points: "40-AD" });
    expect(done).toMatchObject({ phase: "final", sets: "6-3", points: "" });
  });

  it("drops finished matches after the window, dedupes and limits", () => {
    expect(widgetItems([src("d", { status: "completed", endedAt: new Date(NOW - WIDGET_FINAL_MS - 1).toISOString() })], NOW)).toEqual([]);
    expect(widgetItems([src("a"), src("a", { mine: false })], NOW)).toHaveLength(1);
    expect(widgetItems(Array.from({ length: 10 }, (_, i) => src(`m${i}`)), NOW, 3)).toHaveLength(3);
  });

  it("labels missing sides TBD and keeps the start time", () => {
    const [row] = widgetItems([src("m", { a: "", scheduledTime: "2026-10-13T13:00:00Z", mine: false })], NOW);
    expect(row).toEqual({ id: "m", a: "TBD", b: "TUN", at: Date.parse("2026-10-13T13:00:00Z"), court: "Court 1", phase: "upcoming", sets: "", points: "", mine: false });
  });
});

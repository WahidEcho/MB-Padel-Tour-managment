import { describe, expect, it } from "vitest";
import type { MWidget, MWidgetMatch } from "@core";
import { MAX_ENTRIES, widgetTimeline } from "./timeline";

const row = (id: string, over: Partial<MWidgetMatch> = {}): MWidgetMatch => ({ id, a: "A", b: "B", at: null, court: "", phase: "upcoming", sets: "", points: "", mine: true, ...over });
const NOW = 1_000_000;

describe("widgetTimeline", () => {
  it("draws now and again at each future start, once per time", () => {
    const w: MWidget = { signedIn: true, updatedAt: NOW, items: [row("live", { phase: "live" }), row("b", { at: NOW + 2000 }), row("a", { at: NOW + 1000 }), row("same", { at: NOW + 1000 }), row("past", { at: NOW - 5 })] };
    expect(widgetTimeline(w, NOW).map((e) => e.date.getTime())).toEqual([NOW, NOW + 1000, NOW + 2000]);
  });

  it("keeps the timeline short", () => {
    const w: MWidget = { signedIn: true, updatedAt: NOW, items: Array.from({ length: 20 }, (_, i) => row(`m${i}`, { at: NOW + (i + 1) * 1000 })) };
    expect(widgetTimeline(w, NOW)).toHaveLength(MAX_ENTRIES);
  });

  it("an empty widget still gets one entry", () => {
    expect(widgetTimeline({ signedIn: false, updatedAt: NOW, items: [] }, NOW)).toHaveLength(1);
  });
});

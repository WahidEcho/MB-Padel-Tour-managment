import { View } from "react-native";
import { STATS_NOTES, statLines, type SetDuration, type SideStats } from "@core";
import { useTheme } from "../theme/ThemeProvider";
import { Card } from "./Bits";
import { Body, Eyebrow, Num } from "./Text";
import { useT } from "../i18n";
import { tr, type Key } from "../i18n/t";

const BAR_H = 6;

/** Each stat row by its id (statLines' `key`), in the app's language. */
const STAT_KEYS: Record<string, Key> = {
  aces: "hero.statAces",
  doubleFaults: "hero.statDoubleFaults",
  breakPoints: "hero.statBreakPoints",
  pointsWon: "hero.statPointsWon",
  servicePoints: "hero.statServicePoints",
  returnPoints: "hero.statReturnPoints",
  gamesWon: "hero.statGamesWon",
  longestRun: "hero.statLongestRun",
};

/** "1h 24m", "38m", "45s" in the app's language. */
function duration(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return "—";
  if (s < 60) return tr("hero.durSeconds", { s: Math.max(0, Math.round(s)) });
  const m = Math.round(s / 60);
  if (m < 60) return tr("hero.durMinutes", { m });
  return tr("hero.durHours", { h: Math.floor(m / 60), m: String(m % 60).padStart(2, "0") });
}

/** The shared module's fixed words (set labels, time labels, notes) in the app's language. */
function statsWord(w: string): string {
  if (w === "Stats") return tr("hero.stats");
  if (w === "Match time") return tr("hero.matchTime");
  if (w === "Time on court") return tr("hero.timeOnCourt");
  if (w === "Match tie-break") return tr("hero.matchTiebreak");
  if (w === STATS_NOTES.final_score) return tr("hero.noteFinalScore");
  if (w === STATS_NOTES.no_points) return tr("hero.noteNoPoints");
  if (w === STATS_NOTES.unsupported) return tr("hero.noteUnsupported");
  const set = /^Set (\d+)$/.exec(w);
  if (set) return tr("hero.setN", { n: set[1] });
  return w;
}

/**
 * Two-column stat bars: side A grows left from the middle, side B right. Side A
 * wears the ball colour and side B the skin colour, as on the momentum chart.
 */
function Bar({ share, side, lead }: { share: number; side: "A" | "B"; lead: boolean }) {
  const { t } = useTheme();
  const fill = side === "A" ? t.ball : t.skinA;
  const pct = `${Math.max(0, Math.min(1, share)) * 100}%` as const;
  return (
    <View style={{ flex: 1, height: BAR_H, borderRadius: BAR_H / 2, backgroundColor: t.chip, overflow: "hidden", flexDirection: "row", justifyContent: side === "A" ? "flex-end" : "flex-start" }}>
      <View
        style={{
          width: pct,
          height: BAR_H,
          borderRadius: BAR_H / 2,
          backgroundColor: fill,
          opacity: lead ? 1 : 0.55,
          // Yellow on a light surface needs an edge to be seen.
          borderWidth: side === "A" && t.scheme === "light" ? 1 : 0,
          borderColor: t.ballInk,
        }}
      />
    </View>
  );
}

export function StatsCard({
  title,
  sides,
  aLabel,
  bLabel,
  time,
  sets,
  note,
  testID,
}: {
  title?: string;
  sides: { A: SideStats; B: SideStats } | null;
  aLabel: string;
  bLabel: string;
  /** "Match time" or "Time on court", and its seconds. */
  time?: { label: string; seconds: number | null } | null;
  sets?: SetDuration[];
  /** Shown instead of (or under) the bars: "Recorded point by point only…". */
  note?: string | null;
  testID?: string;
}) {
  const tr = useT();
  const lines = (sides ? statLines(sides) : []).map((l) => ({ ...l, label: STAT_KEYS[l.key] ? tr(STAT_KEYS[l.key]) : l.label }));
  const heading = title ? statsWord(title) : tr("hero.stats");
  return (
    <Card style={{ marginTop: 12, gap: 14 }}>
      <View testID={testID} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <Eyebrow>{heading}</Eyebrow>
        {time ? (
          <Body tone="ink2" size={12} accessibilityLabel={`${statsWord(time.label)} ${duration(time.seconds)}`}>
            {statsWord(time.label)} <Body weight="semi" size={12}>{duration(time.seconds)}</Body>
          </Body>
        ) : null}
      </View>
      {lines.length ? (
        <>
          <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
            <Eyebrow tone="ink" size={11} numberOfLines={1} style={{ flex: 1 }}>{aLabel}</Eyebrow>
            <Eyebrow tone="ink" size={11} numberOfLines={1} style={{ flex: 1, textAlign: "right" }}>{bLabel}</Eyebrow>
          </View>
          <View style={{ gap: 14 }}>
            {lines.map((l) => (
              <View key={l.key} accessible accessibilityLabel={tr("hero.statA11y", { label: l.label, a: aLabel, av: l.a, b: bLabel, bv: l.b })} style={{ gap: 6 }}>
                <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                  <Num size={16} tone={l.lead === "A" ? "ink" : "ink2"} style={{ minWidth: 64 }}>{l.a}</Num>
                  <Body tone="ink2" size={12.5} numberOfLines={2} style={{ flexShrink: 1, textAlign: "center" }}>{l.label}</Body>
                  <Num size={16} tone={l.lead === "B" ? "ink" : "ink2"} style={{ minWidth: 64, textAlign: "right" }}>{l.b}</Num>
                </View>
                <View style={{ flexDirection: "row", gap: 4 }}>
                  <Bar share={l.aBar} side="A" lead={l.lead !== "B"} />
                  <Bar share={l.bBar} side="B" lead={l.lead !== "A"} />
                </View>
              </View>
            ))}
          </View>
        </>
      ) : null}
      {sets && sets.length > 1 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>
          {sets.map((s) => (
            <Body key={s.set} tone="ink2" size={12}>
              {statsWord(s.label)} <Body weight="semi" size={12}>{duration(s.seconds)}</Body>
            </Body>
          ))}
        </View>
      ) : null}
      {note ? <Body tone="ink2" size={12.5}>{statsWord(note)}</Body> : null}
    </Card>
  );
}

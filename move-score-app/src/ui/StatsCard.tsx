import { View } from "react-native";
import { durationText, statLines, type SetDuration, type SideStats } from "@core";
import { useTheme } from "../theme/ThemeProvider";
import { Card } from "./Bits";
import { Body, Eyebrow, Num } from "./Text";

const BAR_H = 6;

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
  title = "Stats",
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
  const lines = sides ? statLines(sides) : [];
  return (
    <Card style={{ marginTop: 12, gap: 14 }}>
      <View testID={testID} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <Eyebrow>{title}</Eyebrow>
        {time ? (
          <Body tone="ink2" size={12} accessibilityLabel={`${time.label} ${durationText(time.seconds)}`}>
            {time.label} <Body weight="semi" size={12}>{durationText(time.seconds)}</Body>
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
              <View key={l.key} accessible accessibilityLabel={`${l.label}: ${aLabel} ${l.a}, ${bLabel} ${l.b}`} style={{ gap: 6 }}>
                <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                  <Num size={16} tone={l.lead === "A" ? "ink" : "ink2"} style={{ minWidth: 64 }}>{l.a}</Num>
                  <Body tone="ink2" size={12.5} numberOfLines={1} style={{ flexShrink: 1, textAlign: "center" }}>{l.label}</Body>
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
              {s.label} <Body weight="semi" size={12}>{durationText(s.seconds)}</Body>
            </Body>
          ))}
        </View>
      ) : null}
      {note ? <Body tone="ink2" size={12.5}>{note}</Body> : null}
    </Card>
  );
}

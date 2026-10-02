import { useMemo } from "react";
import { View } from "react-native";
import Svg, { Defs, Line, LinearGradient, Path, Stop } from "react-native-svg";
import { useTheme } from "../theme/ThemeProvider";
import type { MTimelinePoint } from "@core";
import { Eyebrow } from "./Text";

const DOT = 10;

/**
 * Who is on top, point by point: a line that swings toward whichever side is
 * winning points, with recent points weighing most. Drawn from the timeline the
 * server already records.
 */
export function Momentum({ points, aLabel, bLabel, height = 92 }: { points: MTimelinePoint[]; aLabel: string; bLabel: string; height?: number }) {
  const { t } = useTheme();
  const { d, area, end, lead } = useMemo(() => {
    let v = 0;
    const vals = points.map((p) => (v = v * 0.86 + (p.w === "A" ? 1 : -1)));
    if (vals.length < 2) return { d: "", area: "", end: null as null | [number, number], lead: null as null | "A" | "B" };
    const max = Math.max(4, ...vals.map(Math.abs));
    const mid = height / 2;
    const pts = vals.map((y, i) => [(i / (vals.length - 1)) * 320, mid - (y / max) * (mid - 6)] as [number, number]);
    const path = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
    return { d: path, area: `${path} L320 ${mid} L0 ${mid} Z`, end: pts[pts.length - 1]!, lead: vals[vals.length - 1]! >= 0 ? ("A" as const) : ("B" as const) };
  }, [points, height]);
  return (
    <View accessible accessibilityLabel={lead ? `Momentum: ${lead === "A" ? aLabel : bLabel} on top` : "Momentum not available yet"}>
      <Svg width="100%" height={height} viewBox={`0 0 320 ${height}`} preserveAspectRatio="none">
        <Defs>
          <LinearGradient id="mg" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={t.ball} stopOpacity={0.45} />
            <Stop offset="0.5" stopColor={t.ball} stopOpacity={0} />
            <Stop offset="0.5" stopColor={t.skinA} stopOpacity={0} />
            <Stop offset="1" stopColor={t.skinA} stopOpacity={0.5} />
          </LinearGradient>
        </Defs>
        <Line x1="0" y1={height / 2} x2="320" y2={height / 2} stroke={t.ink3} strokeOpacity={0.4} strokeDasharray="3 4" />
        {d ? <Path d={area} fill="url(#mg)" /> : null}
        {d ? <Path d={d} fill="none" stroke={t.ink} strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" /> : null}
      </Svg>
      {/* The SVG stretches to the card's width; the end dot sits outside it so it stays round. */}
      {end ? (
        <View
          pointerEvents="none"
          style={{ position: "absolute", left: `${(end[0] / 320) * 100}%`, top: end[1] - DOT / 2, marginLeft: -DOT / 2, width: DOT, height: DOT, borderRadius: DOT / 2, backgroundColor: t.ball, borderWidth: 1.5, borderColor: t.ballInk }}
        />
      ) : null}
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 6 }}>
        <Eyebrow size={10} tone="ink3">{aLabel}</Eyebrow>
        <Eyebrow size={10} tone="ink3">{lead ? `${lead === "A" ? aLabel : bLabel} on top` : "No points yet"}</Eyebrow>
        <Eyebrow size={10} tone="ink3">{bLabel}</Eyebrow>
      </View>
    </View>
  );
}

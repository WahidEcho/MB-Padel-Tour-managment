import { useEffect, useState } from "react";
import { View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Svg, { Defs, Ellipse, RadialGradient, Stop } from "react-native-svg";
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { useTheme } from "../theme/ThemeProvider";
import { F } from "../theme/type";
import { Flag } from "./Bits";

export interface PinNation {
  code: string;
  iso2: string | null;
  name: string;
}

const GOLD_RIM = "#8A7000";

/** The moving highlight across a collected pin (the prototype's `sheen`). */
function Sheen({ d }: { d: number }) {
  const { calm } = useTheme();
  const p = useSharedValue(0);
  useEffect(() => {
    if (calm) return;
    p.value = withRepeat(withTiming(1, { duration: 3000, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(p);
  }, [calm, p]);
  const s = useAnimatedStyle(() => ({ transform: [{ translateX: -d * 1.3 + p.value * d * 2.6 }, { rotate: "30deg" }] }));
  if (calm) return null;
  return (
    <Animated.View pointerEvents="none" style={[{ position: "absolute", top: -d * 0.25, left: 0, width: d, height: d * 1.5 }, s]}>
      <LinearGradient colors={["rgba(255,255,255,0)", "rgba(255,255,255,0.7)", "rgba(255,255,255,0)"]} locations={[0.35, 0.5, 0.65]} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={{ flex: 1 }} />
    </Animated.View>
  );
}

function Pin({ n, got, d }: { n: PinNation; got: boolean; d: number }) {
  const { t } = useTheme();
  const flag = Math.round(d * 0.46);
  const code = (
    <Animated.Text style={{ fontFamily: F.data, fontSize: Math.max(10, Math.round(d * 0.15)), letterSpacing: 0.8, marginTop: 4, color: got ? "#3D3200" : t.ink3 }}>{n.code}</Animated.Text>
  );
  if (!got) {
    return (
      <View
        accessible
        accessibilityLabel={`${n.name} pin, not collected yet`}
        style={{ width: d, height: d, borderRadius: d / 2, alignItems: "center", justifyContent: "center", backgroundColor: t.chip, borderWidth: 1, borderStyle: "dashed", borderColor: t.line }}
      >
        <View style={{ opacity: 0.35 }}>
          <Flag iso2={n.iso2} code={n.code} size={flag} />
        </View>
        {code}
      </View>
    );
  }
  return (
    <View accessible accessibilityLabel={`${n.name} pin, collected`} style={{ width: d, height: d, borderRadius: d / 2, boxShadow: `0 4px 0 ${GOLD_RIM}, 0 10px 20px rgba(0,0,0,0.3)` }}>
      <View style={{ flex: 1, borderRadius: d / 2, overflow: "hidden", alignItems: "center", justifyContent: "center" }}>
        <LinearGradient colors={["#FFE066", "#C9A400"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ position: "absolute", inset: 0 }} />
        <Svg width={d} height={d} style={{ position: "absolute", left: 0, top: 0 }} pointerEvents="none">
          <Defs>
            <RadialGradient id="hl" cx={d * 0.35} cy={d * 0.3} rx={d * 0.4} ry={d * 0.4} fx={d * 0.35} fy={d * 0.3} gradientUnits="userSpaceOnUse">
              <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0.6} />
              <Stop offset="1" stopColor="#FFFFFF" stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Ellipse cx={d * 0.35} cy={d * 0.3} rx={d * 0.4} ry={d * 0.4} fill="url(#hl)" />
        </Svg>
        <View style={{ padding: 2, borderRadius: 4, backgroundColor: GOLD_RIM }}>
          <Flag iso2={n.iso2} code={n.code} size={flag} />
        </View>
        {code}
        <Sheen d={d} />
      </View>
    </View>
  );
}

/** The pin binder: four to a row, each a circle with the nation's flag and its three-letter code. */
export function Pins({ nations, got }: { nations: PinNation[]; got: string[] }) {
  const [w, setW] = useState(0);
  const d = w ? Math.floor((w - 30) / 4) : 0;
  const have = new Set(got);
  return (
    <View onLayout={(e) => setW(e.nativeEvent.layout.width)} style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, rowGap: 14 }}>
      {d > 0 && nations.map((n) => <Pin key={n.code} n={n} got={have.has(n.code)} d={d} />)}
    </View>
  );
}

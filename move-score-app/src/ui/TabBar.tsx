import { useEffect, useState } from "react";
import { Pressable, View, type LayoutChangeEvent, useWindowDimensions } from "react-native";
import { BlurView } from "expo-blur";
import * as Haptics from "expo-haptics";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { BottomTabBarProps } from "expo-router/build/react-navigation/bottom-tabs";
import { useTheme } from "../theme/ThemeProvider";
import { Body } from "./Text";

const ICONS: Record<string, (c: string) => React.ReactNode> = {
  index: (c) => (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={1.8}>
      <Circle cx={12} cy={12} r={9} />
      <Path d="M15.5 8.5l-2 5-5 2 2-5z" />
    </Svg>
  ),
  matches: (c) => (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={1.8}>
      <Rect x={3} y={5} width={18} height={14} rx={3} />
      <Path d="M12 5v14M3 12h18" />
    </Svg>
  ),
  pass: (c) => (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={2}>
      <Rect x={5} y={3} width={14} height={18} rx={3} />
      <Path d="M9 7h6M9 16h3" />
    </Svg>
  ),
  players: (c) => (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={1.8}>
      <Circle cx={12} cy={8} r={4} />
      <Path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
    </Svg>
  ),
  following: (c) => (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={1.8}>
      <Path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />
    </Svg>
  ),
};

const LABELS: Record<string, string> = { index: "Discover", matches: "Matches", pass: "My pass", players: "Players", following: "Following" };

/** The tab bar's active marker is the ball, bouncing to whichever tab you tap. */
export function TabBar({ state, navigation }: BottomTabBarProps) {
  const { t, calm } = useTheme();
  const insets = useSafeAreaInsets();
  const [width, setWidth] = useState(0);
  // On a tablet the bar keeps phone proportions, centred under the content column.
  const win = useWindowDimensions();
  const side = Math.max(12, (win.width - 560) / 2);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const n = state.routes.length;
  const slot = width / n;
  useEffect(() => {
    if (!width) return;
    const target = slot * state.index + slot / 2 - 3.5;
    x.value = calm ? target : withSpring(target, { damping: 14, stiffness: 140 });
    if (!calm) y.value = withSequence(withTiming(-10, { duration: 160 }), withSpring(0, { damping: 6 }));
  }, [state.index, width, slot, x, y, calm]);
  const ball = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { translateY: y.value }], opacity: state.routes[state.index]?.name === "pass" ? 0 : 1 }));
  return (
    <View style={{ position: "absolute", left: side, right: side, bottom: Math.max(insets.bottom, 10), height: 70, borderRadius: 26, overflow: "hidden", borderWidth: 1, borderColor: t.line }} onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
      <BlurView intensity={40} tint={t.scheme === "dark" ? "dark" : "light"} style={{ position: "absolute", inset: 0, backgroundColor: t.scheme === "dark" ? "rgba(10,16,34,0.78)" : "rgba(255,255,255,0.82)" }} />
      <Animated.View style={[{ position: "absolute", top: 7, width: 7, height: 7, borderRadius: 4, backgroundColor: t.ball, shadowColor: t.ball, shadowOpacity: 0.9, shadowRadius: 6, borderWidth: t.scheme === "light" ? 1.5 : 0, borderColor: t.ballInk }, ball]} />
      <View style={{ flex: 1, flexDirection: "row" }}>
        {state.routes.map((route, i) => {
          const focused = state.index === i;
          const isPass = route.name === "pass";
          const color = focused ? t.ink : t.ink3;
          return (
            <Pressable
              key={route.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={LABELS[route.name]}
              onPress={() => {
                void Haptics.selectionAsync().catch(() => {});
                const e = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
                if (!focused && !e.defaultPrevented) navigation.navigate(route.name);
              }}
              style={({ pressed }) => ({ flex: 1, alignItems: "center", justifyContent: "center", gap: 4, opacity: pressed ? 0.65 : 1 })}
            >
              {isPass ? (
                <View style={{ width: 48, height: 48, borderRadius: 16, backgroundColor: t.btnBg, alignItems: "center", justifyContent: "center", marginTop: -4 }}>{ICONS.pass!(t.btnInk)}</View>
              ) : (
                <>
                  {ICONS[route.name]?.(color)}
                  <Body size={10.5} weight="bold" style={{ color }}>
                    {LABELS[route.name]}
                  </Body>
                </>
              )}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

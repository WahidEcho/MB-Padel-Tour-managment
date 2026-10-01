import { useEffect, useRef, useState } from "react";
import { View, type TextStyle } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withSequence, withTiming } from "react-native-reanimated";
import { useTheme } from "../theme/ThemeProvider";
import { Num } from "./Text";

/**
 * A score that rolls like a scoreboard: the old value slides up and out, the new
 * one slides in from below, and a yellow sweep marks the side that just scored.
 */
export function Rolling({ value, size = 24, sweep = false, tone = "ink", style, height }: { value: string | number; size?: number; sweep?: boolean; tone?: "ink" | "ink2" | "ink3"; style?: TextStyle; height?: number }) {
  const { t, calm } = useTheme();
  const [shown, setShown] = useState(String(value));
  const [prev, setPrev] = useState<string | null>(null);
  const y = useSharedValue(0);
  const bar = useSharedValue(0);
  const first = useRef(true);
  const H = height ?? Math.round(size * 1.35);
  useEffect(() => {
    const next = String(value);
    if (first.current) {
      first.current = false;
      setShown(next);
      return;
    }
    if (next === shown) return;
    if (calm) {
      setShown(next);
      return;
    }
    setPrev(shown);
    setShown(next);
    y.value = 0;
    y.value = withTiming(1, { duration: 420, easing: Easing.bezier(0.2, 0.9, 0.25, 1.15) });
    if (sweep) bar.value = withSequence(withTiming(1, { duration: 380 }), withTiming(0, { duration: 260 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const outStyle = useAnimatedStyle(() => ({ transform: [{ translateY: -H * y.value }], opacity: 1 - y.value }));
  const inStyle = useAnimatedStyle(() => ({ transform: [{ translateY: prev === null ? 0 : H * (1 - y.value) }], opacity: prev === null ? 1 : y.value }));
  const barStyle = useAnimatedStyle(() => ({ opacity: bar.value, transform: [{ scaleX: bar.value }] }));
  return (
    <View style={{ height: H, overflow: "hidden", justifyContent: "center", alignItems: "center" }}>
      {prev !== null && (
        <Animated.View style={[{ position: "absolute" }, outStyle]}>
          <Num size={size} tone={tone} style={style}>
            {prev}
          </Num>
        </Animated.View>
      )}
      <Animated.View style={inStyle}>
        <Num size={size} tone={tone} style={style}>
          {shown}
        </Num>
      </Animated.View>
      <Animated.View style={[{ position: "absolute", left: "10%", right: "10%", bottom: 3, height: 3, borderRadius: 3, backgroundColor: t.ball }, barStyle]} />
    </View>
  );
}

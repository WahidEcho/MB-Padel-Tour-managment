import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from "react-native-reanimated";
import { useTheme } from "../theme/ThemeProvider";

/** Two slow-swaying beams of the event's colours over the floor, like the brand artwork. */
export function StageLight({ height = 420, swing = 0 }: { height?: number; swing?: number }) {
  const { t, calm } = useTheme();
  const a = useSharedValue(0);
  useEffect(() => {
    // Reduce Motion can be switched on while the beams sway: stop them, not just skip starting them.
    if (calm) {
      cancelAnimation(a);
      a.value = 0;
      return;
    }
    a.value = withRepeat(withSequence(withTiming(1, { duration: 9000, easing: Easing.inOut(Easing.sin) }), withTiming(0, { duration: 9000, easing: Easing.inOut(Easing.sin) })), -1);
    return () => cancelAnimation(a);
  }, [a, calm]);
  const left = useAnimatedStyle(() => ({ transform: [{ rotate: `${-24 + a.value * 12 + swing}deg` }] }));
  const right = useAnimatedStyle(() => ({ transform: [{ rotate: `${24 - a.value * 10 + swing}deg` }] }));
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { height, overflow: "hidden" }]}>
      <Animated.View style={[styles.beam, { left: -60 }, left]}>
        <LinearGradient colors={[t.glowA, "transparent"]} style={StyleSheet.absoluteFill} />
      </Animated.View>
      <Animated.View style={[styles.beam, { right: -60 }, right]}>
        <LinearGradient colors={[t.glowB, "transparent"]} style={StyleSheet.absoluteFill} />
      </Animated.View>
      <LinearGradient colors={["transparent", t.floor]} style={[StyleSheet.absoluteFill, { top: height * 0.55 }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  beam: { position: "absolute", top: -160, width: 220, height: 640, opacity: 0.9, borderBottomLeftRadius: 120, borderBottomRightRadius: 120, transformOrigin: "50% 0%" },
});

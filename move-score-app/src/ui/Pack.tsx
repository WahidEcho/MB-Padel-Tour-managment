import { View } from "react-native";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { BALL } from "../theme/palette";
import { F } from "../theme/type";
import { Eyebrow } from "./Text";
import { DISPLAY_SCALE, usePassSize } from "./PassCard";

// The wordmark and title shrink with the pass, so the pack keeps its proportions.
const MARK = Math.round(190 * DISPLAY_SCALE);
const TITLE = Math.round(30 * DISPLAY_SCALE);

/**
 * The pass arrives sealed. Drag a finger along the perforation to tear it open;
 * the top flies off and the pass rises out (see the Pass tab). Same size as the pass.
 */
export function Pack({ title, onOpen }: { title: string; onOpen: () => void }) {
  const { w: PASS_W, h: PASS_H } = usePassSize();
  const tear = useSharedValue(0);
  const gone = useSharedValue(0);
  const ticks = useSharedValue(0);
  const buzz = (n: number) => {
    if (n % 3 === 0) void Haptics.selectionAsync().catch(() => {});
  };
  const open = () => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    onOpen();
  };
  const pan = Gesture.Pan()
    .onChange((e) => {
      if (gone.value) return;
      tear.value = Math.min(1, Math.abs(e.translationX) / (PASS_W * 0.8));
      const step = Math.floor(tear.value * 12);
      if (step !== ticks.value) {
        ticks.value = step;
        runOnJS(buzz)(step);
      }
      if (tear.value >= 1) {
        gone.value = 1;
        runOnJS(open)();
      }
    })
    .onEnd(() => {
      if (!gone.value) tear.value = withSpring(0);
    });
  const tap = Gesture.Tap().numberOfTaps(2).onEnd(() => {
    gone.value = 1;
    tear.value = withTiming(1);
    runOnJS(open)();
  });
  const strip = useAnimatedStyle(() => ({ width: `${tear.value * 100}%` }));
  // The tear's travel is in the pack's own size, so a smaller pass flies a shorter way.
  const flyX = Math.round(PASS_W * 0.22);
  const flyUp = Math.round(PASS_H * 0.57);
  const top = useAnimatedStyle(() => ({ transform: [{ translateX: gone.value ? withTiming(flyX, { duration: 700 }) : 0 }, { translateY: gone.value ? withTiming(-flyUp, { duration: 700 }) : 0 }, { rotate: gone.value ? withTiming("28deg", { duration: 700 }) : "0deg" }], opacity: gone.value ? withTiming(0, { duration: 700 }) : 1 }));
  const body = useAnimatedStyle(() => ({ transform: [{ translateY: gone.value ? withTiming(PASS_H, { duration: 800 }) : 0 }], opacity: gone.value ? withTiming(0, { duration: 800 }) : 1 }));
  return (
    <GestureDetector gesture={Gesture.Exclusive(pan, tap)}>
      <View
        style={{ width: PASS_W, height: PASS_H }}
        accessible
        accessibilityRole="button"
        accessibilityLabel="Sealed event pass"
        accessibilityHint="Opens your event pass. Or drag across the top to tear it open."
        // A screen reader's double-tap is "activate": it never reaches the gesture handlers.
        accessibilityActions={[{ name: "activate", label: "Open the pass" }]}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName !== "activate" || gone.value) return;
          gone.value = 1;
          tear.value = withTiming(1);
          open();
        }}
      >
        <Animated.View style={[{ height: 64, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderBottomLeftRadius: 4, borderBottomRightRadius: 4, overflow: "hidden", borderWidth: 1, borderColor: "rgba(255,255,255,0.12)" }, top]}>
          <LinearGradient colors={["#0b1640", "#01041A"]} style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <Eyebrow size={11} style={{ color: BALL, letterSpacing: 3 }}>← DRAG TO OPEN →</Eyebrow>
          </LinearGradient>
        </Animated.View>
        <View style={{ height: 6, marginHorizontal: 10, borderTopWidth: 2, borderStyle: "dashed", borderColor: "rgba(252,252,0,0.7)" }}>
          <Animated.View style={[{ position: "absolute", top: -12, left: -10, height: 22, borderRadius: 8, backgroundColor: "rgba(252,252,0,0.55)" }, strip]} />
        </View>
        <Animated.View style={[{ flex: 1, borderTopLeftRadius: 4, borderTopRightRadius: 4, borderBottomLeftRadius: 22, borderBottomRightRadius: 22, overflow: "hidden", borderWidth: 1, borderColor: "rgba(255,255,255,0.12)" }, body]}>
          <LinearGradient colors={["#0b1640", "#01041A"]} style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 20 }}>
            <Image source={require("../../assets/brand/movescore-wordmark.png")} style={{ width: MARK, height: MARK * (74 / 997) }} contentFit="contain" />
            <Animated.Text style={{ fontFamily: F.display, fontSize: TITLE, lineHeight: TITLE - 1, color: "#E8ECF4", textTransform: "uppercase", textAlign: "center" }}>{title}</Animated.Text>
            <View style={{ backgroundColor: BALL, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 }}>
              <Eyebrow size={10} style={{ color: "#05060A" }}>Event pass</Eyebrow>
            </View>
          </LinearGradient>
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

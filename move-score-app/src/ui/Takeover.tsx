import { useEffect, useRef } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import * as Haptics from "expo-haptics";
import Animated, { Easing, FadeIn, FadeOut, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { LinearGradient } from "expo-linear-gradient";
import { BALL } from "../theme/palette";
import { F } from "../theme/type";
import { Body, Eyebrow } from "./Text";
import { Button } from "./Bits";

export interface TakeoverMoment {
  key: string;
  kicker: string;
  words: [string, string];
  who: string;
  final: boolean;
}

/**
 * SET POINT, MATCH POINT, TIE WON: a short full-screen moment on the live match,
 * with a haptic. A final moment stays until tapped and offers to share it.
 */
export function Takeover({ moment, onDone, onShare, calm }: { moment: TakeoverMoment | null; onDone: () => void; onShare: () => void; calm: boolean }) {
  const sweep = useSharedValue(0);
  // The parent re-renders on every poll; the moment plays once per key, whatever it passes.
  const latest = useRef({ onDone, calm });
  useEffect(() => {
    latest.current = { onDone, calm };
  });
  const key = moment?.key ?? null;
  const final = moment?.final ?? false;
  useEffect(() => {
    if (!key) return;
    void Haptics.notificationAsync(final ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning).catch(() => {});
    sweep.value = 0;
    sweep.value = withTiming(1, { duration: 2200, easing: Easing.inOut(Easing.sin) });
    if (!final) {
      const id = setTimeout(() => latest.current.onDone(), latest.current.calm ? 1200 : 2300);
      return () => clearTimeout(id);
    }
  }, [key, final, sweep]);
  const beam = useAnimatedStyle(() => ({ transform: [{ rotate: `${-35 + sweep.value * 70}deg` }] }));
  if (!moment) return null;
  return (
    <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(220)} style={[StyleSheet.absoluteFill, styles.wrap]}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onDone} accessibilityRole="button" accessibilityLabel="Close" />
      {!calm && (
        <Animated.View pointerEvents="none" style={[styles.beam, beam]}>
          <LinearGradient colors={["rgba(252,252,0,0.0)", "rgba(252,252,0,0.45)", "rgba(252,252,0,0.0)"]} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={StyleSheet.absoluteFill} />
        </Animated.View>
      )}
      <View pointerEvents="box-none" style={{ alignItems: "center", gap: 10, paddingHorizontal: 24 }}>
        <Eyebrow tone="ink2" style={{ color: "#9AA4B8", letterSpacing: 3 }}>{moment.kicker}</Eyebrow>
        {moment.words.map((w, i) => (
          <Animated.Text key={w + i} entering={FadeIn.delay(i * 80).duration(300)} style={styles.big}>
            {w}
          </Animated.Text>
        ))}
        <Body weight="bold" style={{ color: "#E8ECF4" }}>{moment.who}</Body>
        {moment.final && <Button label="Share this moment" onPress={onShare} style={{ marginTop: 18, alignSelf: "stretch" }} />}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { backgroundColor: "rgba(0,0,8,0.88)", alignItems: "center", justifyContent: "center", zIndex: 50 },
  beam: { position: "absolute", top: "-40%", width: 160, height: "180%", transformOrigin: "50% 0%" },
  big: { fontFamily: F.display, fontSize: 64, lineHeight: 58, color: BALL, textTransform: "uppercase", textAlign: "center", textShadowColor: "rgba(252,252,0,0.45)", textShadowRadius: 30 },
});


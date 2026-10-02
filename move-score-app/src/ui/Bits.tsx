import { useEffect, type ReactNode } from "react";
import { Pressable, StyleSheet, View, type ViewStyle, type StyleProp } from "react-native";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withSpring, withTiming } from "react-native-reanimated";
import { useTheme } from "../theme/ThemeProvider";
import { Body, Eyebrow, Num } from "./Text";
import { config } from "../config";

export function Wordmark({ height = 15 }: { height?: number }) {
  return (
    <View style={{ backgroundColor: "#01041A", borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, alignSelf: "flex-start" }}>
      <Image source={require("../../assets/brand/movescore-wordmark.png")} style={{ height, width: height * (997 / 74) }} contentFit="contain" accessibilityLabel="Move Score" />
    </View>
  );
}

export function Card({ children, style, onPress, accessibilityLabel }: { children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void; accessibilityLabel?: string }) {
  const { t } = useTheme();
  const base = { backgroundColor: t.surface, borderColor: t.line, borderWidth: StyleSheet.hairlineWidth * 2, borderRadius: 22, padding: 14 };
  if (!onPress) return <View style={[base, style]}>{children}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={onPress} style={({ pressed }) => [base, style, pressed && { opacity: 0.85, transform: [{ scale: 0.992 }] }]}>
      {children}
    </Pressable>
  );
}

export function Chip({ label, ball, style }: { label: string; ball?: boolean; style?: StyleProp<ViewStyle> }) {
  const { t } = useTheme();
  return (
    <View style={[{ backgroundColor: ball ? t.ball : t.chip, paddingHorizontal: 9, paddingVertical: 5, borderRadius: 999, alignSelf: "flex-start" }, style]}>
      <Eyebrow size={10} tone={ball ? "onBall" : "ink2"} style={{ letterSpacing: 0.8 }}>
        {label}
      </Eyebrow>
    </View>
  );
}

/** The word LIVE with a pulsing dot: never colour alone. */
export function LivePill({ label = "LIVE" }: { label?: string }) {
  const { t, calm } = useTheme();
  const s = useSharedValue(0);
  useEffect(() => {
    if (calm) {
      // Reduce Motion switched on mid-pulse: stop the loop and rest the ring.
      cancelAnimation(s);
      s.value = 0;
      return;
    }
    s.value = withRepeat(withTiming(1, { duration: 1600 }), -1);
    return () => cancelAnimation(s);
  }, [s, calm]);
  const ring = useAnimatedStyle(() => ({ opacity: 0.7 * (1 - s.value), transform: [{ scale: 1 + s.value * 1.6 }] }));
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }} accessibilityLabel={label}>
      <View style={{ width: 8, height: 8 }}>
        <Animated.View style={[{ position: "absolute", width: 8, height: 8, borderRadius: 4, backgroundColor: t.live }, ring]} />
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: t.live }} />
      </View>
      <Eyebrow size={11} tone="live" style={{ letterSpacing: 1.1 }}>
        {label}
      </Eyebrow>
    </View>
  );
}

/** A nation's flag from the platform's own flag set, with the code as a fallback. */
export function Flag({ iso2, code, size = 22 }: { iso2: string | null | undefined; code?: string | null; size?: number }) {
  const { t } = useTheme();
  const h = Math.round(size * 0.68);
  if (!iso2 || !/^[a-z]{2}$/.test(iso2)) {
    return (
      <View style={{ width: size, height: h, borderRadius: 3, backgroundColor: t.surface2, alignItems: "center", justifyContent: "center" }}>
        <Num size={Math.max(8, size * 0.36)} tone="ink2">{(code ?? "").slice(0, 3)}</Num>
      </View>
    );
  }
  return <Image source={{ uri: `${config.apiBaseUrl}/flags/${iso2}.svg` }} style={{ width: size, height: h, borderRadius: 3 }} contentFit="cover" cachePolicy="disk" accessibilityLabel={code ?? iso2} />;
}

export function SectionHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", marginTop: 26, marginBottom: 10 }}>
      <Body weight="bold" size={14} style={{ textTransform: "uppercase", letterSpacing: 0.6 }}>
        {title}
      </Body>
      {action ? (
        <Pressable onPress={onAction} hitSlop={10} accessibilityRole="button">
          <Body tone="blue" weight="semi" size={13}>
            {action}
          </Body>
        </Pressable>
      ) : null}
    </View>
  );
}

export function Button({ label, onPress, kind = "primary", disabled, icon, style }: { label: string; onPress: () => void; kind?: "primary" | "ghost" | "danger"; disabled?: boolean; icon?: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { t } = useTheme();
  const bg = kind === "primary" ? t.btnBg : kind === "danger" ? t.liveFill : t.chip;
  const ink = kind === "primary" ? t.btnInk : kind === "danger" ? "#FFFFFF" : t.ink;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={() => {
        void Haptics.selectionAsync().catch(() => {});
        onPress();
      }}
      style={({ pressed }) => [
        { backgroundColor: bg, borderRadius: 16, paddingVertical: 14, paddingHorizontal: 16, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8, minHeight: 48, opacity: disabled ? 0.5 : 1, borderWidth: kind === "ghost" ? 1 : 0, borderColor: t.line },
        pressed && { transform: [{ scale: 0.98 }] },
        style,
      ]}
    >
      {icon}
      <Body weight="bold" size={15} style={{ color: ink }}>
        {label}
      </Body>
    </Pressable>
  );
}

/** Follow / star toggle that pops when switched on. */
export function ToggleButton({ on, onLabel, offLabel, onPress, compact }: { on: boolean; onLabel: string; offLabel: string; onPress: () => void; compact?: boolean }) {
  const { t } = useTheme();
  const s = useSharedValue(1);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      hitSlop={6}
      onPress={() => {
        if (!on) {
          s.value = withSequence(withSpring(1.14, { damping: 6 }), withSpring(1));
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        }
        onPress();
      }}
    >
      <Animated.View style={[{ backgroundColor: on ? t.ball : t.chip, borderColor: on ? "transparent" : t.line, borderWidth: 1, borderRadius: 999, paddingHorizontal: compact ? 10 : 13, paddingVertical: compact ? 6 : 8 }, style]}>
        <Body weight="bold" size={13} style={{ color: on ? t.ballInk : t.ink }}>
          {on ? onLabel : offLabel}
        </Body>
      </Animated.View>
    </Pressable>
  );
}

export function Empty({ title, body }: { title: string; body?: string }) {
  return (
    <Card style={{ alignItems: "center", paddingVertical: 28, gap: 6 }}>
      <Body weight="semi">{title}</Body>
      {body ? (
        <Body tone="ink2" size={13} style={{ textAlign: "center" }}>
          {body}
        </Body>
      ) : null}
    </Card>
  );
}

import { Pressable, View } from "react-native";
import { router, type Href } from "expo-router";
import Svg, { Circle, Path } from "react-native-svg";
import { useTheme } from "../theme/ThemeProvider";
import { session } from "../state/session";
import { Body, Num } from "./Text";
import type { ReactNode } from "react";

/**
 * Back to where the person came from. Opened from a link or an alert there is
 * nothing to go back to, so it goes to `fallback` (the page the label names)
 * instead of leaving them stranded.
 */
export function BackHeader({ label, right, fallback = "/" }: { label: string; right?: ReactNode; fallback?: Href }) {
  const { t } = useTheme();
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", height: 44, marginBottom: 8, gap: 10 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Back to ${label}`}
        onPress={() => (router.canGoBack() ? router.back() : router.replace(fallback))}
        style={({ pressed }) => [
          { backgroundColor: t.chip, borderColor: t.line, borderWidth: 1, borderRadius: 999, paddingVertical: 7, paddingLeft: 10, paddingRight: 13, flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1 },
          pressed && { opacity: 0.7, transform: [{ scale: 0.97 }] },
        ]}
        hitSlop={8}
      >
        <Body weight="bold" size={15}>‹</Body>
        <Body weight="semi" size={13} numberOfLines={1} style={{ flexShrink: 1 }}>{label}</Body>
      </Pressable>
      {right}
    </View>
  );
}

function initials(name: string | null | undefined): string {
  return (name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

/**
 * The way into Account: a round button filled with the ball colour, so it reads
 * as something to press. Signed in it shows the person's initials; otherwise a
 * person glyph.
 */
export function ProfileButton({ size = 40 }: { size?: number }) {
  const { t } = useTheme();
  const user = session.use((s) => s.user);
  const letters = initials(user?.name);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Account"
      accessibilityHint={user ? `Signed in${user.name ? ` as ${user.name}` : ""}. Alerts, look and sign-in.` : "Alerts, look and sign-in."}
      onPress={() => router.push("/account")}
      hitSlop={10}
      style={({ pressed }) => [
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: t.ball,
          alignItems: "center",
          justifyContent: "center",
          // The ball is about 1.1:1 on the light floor: a dark rim keeps the circle's edge.
          borderWidth: t.scheme === "light" ? 1.5 : 0,
          borderColor: t.ballInk,
          shadowColor: t.ball,
          shadowOpacity: t.scheme === "dark" ? 0.45 : 0,
          shadowRadius: 10,
          shadowOffset: { width: 0, height: 0 },
        },
        pressed && { opacity: 0.8, transform: [{ scale: 0.94 }] },
      ]}
    >
      {letters ? (
        <Num size={Math.round(size * 0.42)} style={{ color: t.ballInk }}>
          {letters}
        </Num>
      ) : (
        <Svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24" fill="none" stroke={t.ballInk} strokeWidth={2.2} strokeLinecap="round">
          <Circle cx={12} cy={8} r={4} />
          <Path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" />
        </Svg>
      )}
    </Pressable>
  );
}

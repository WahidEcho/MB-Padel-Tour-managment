import { Pressable, View } from "react-native";
import { router } from "expo-router";
import { useTheme } from "../theme/ThemeProvider";
import { Body } from "./Text";
import type { ReactNode } from "react";

export function BackHeader({ label, right }: { label: string; right?: ReactNode }) {
  const { t } = useTheme();
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", height: 44, marginBottom: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Back to ${label}`}
        onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
        style={{ backgroundColor: t.chip, borderColor: t.line, borderWidth: 1, borderRadius: 999, paddingVertical: 7, paddingLeft: 10, paddingRight: 13, flexDirection: "row", alignItems: "center", gap: 4 }}
        hitSlop={8}
      >
        <Body weight="bold" size={15}>‹</Body>
        <Body weight="semi" size={13}>{label}</Body>
      </Pressable>
      {right}
    </View>
  );
}

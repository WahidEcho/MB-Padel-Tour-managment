import { Pressable, View } from "react-native";
import * as Haptics from "expo-haptics";
import { useTheme } from "../theme/ThemeProvider";
import { Body } from "./Text";

export function Segments<T extends string>({ value, options, onChange }: { value: T; options: { key: T; label: string }[]; onChange: (k: T) => void }) {
  const { t } = useTheme();
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: "row", gap: 4, backgroundColor: t.chip, padding: 4, borderRadius: 14, marginVertical: 14 }}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <Pressable
            key={o.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => {
              void Haptics.selectionAsync().catch(() => {});
              onChange(o.key);
            }}
            style={{ flex: 1, paddingVertical: 8, borderRadius: 10, alignItems: "center", backgroundColor: on ? t.surface : "transparent" }}
          >
            <Body weight="semi" size={13} tone={on ? "ink" : "ink2"}>
              {o.label}
            </Body>
          </Pressable>
        );
      })}
    </View>
  );
}

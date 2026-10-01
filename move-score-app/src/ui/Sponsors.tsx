import { View } from "react-native";
import { Image } from "expo-image";
import type { MBundle } from "@core";
import { Eyebrow } from "./Text";
import { useTheme } from "../theme/ThemeProvider";

/** The event's partners, as the organiser set them up for the venue screens. */
export function SponsorBand({ sponsors }: { sponsors: MBundle["sponsors"] }) {
  const { t } = useTheme();
  const all = [...(sponsors.main ? [sponsors.main] : []), ...sponsors.footer];
  if (!all.length) return null;
  return (
    <View style={{ marginTop: 28, gap: 10 }}>
      <Eyebrow size={10} tone="ink3" style={{ textAlign: "center" }}>Partners</Eyebrow>
      <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 10 }}>
        {all.map((s) => (
          <View key={s.logoUrl} style={{ backgroundColor: "#FFFFFF", borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6, borderWidth: t.scheme === "light" ? 1 : 0, borderColor: t.line }}>
            <Image source={{ uri: s.logoUrl }} style={{ height: 26, width: Math.min(110, 26 * (s.aspect ?? 2.5)) }} contentFit="contain" accessibilityLabel={s.name || "Partner"} />
          </View>
        ))}
      </View>
    </View>
  );
}

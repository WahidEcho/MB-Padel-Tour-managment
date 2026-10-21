import { Pressable } from "react-native";
import { useEventInfo } from "../api/queries";
import { openEventInfo } from "../nav/links";
import { Body } from "./Text";
import { useT } from "../i18n";

/** "Event info ›" in a tournament's header, once the organiser has published the info. */
export function EventInfoLink({ slug }: { slug: string }) {
  const tr = useT();
  const info = useEventInfo(slug);
  if (!info.data) return null;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={tr("hero.eventInfoA11y")}
      onPress={() => openEventInfo(slug)}
      hitSlop={8}
      style={({ pressed }) => pressed && { opacity: 0.6 }}
    >
      <Body tone="blue" size={13} weight="semi">{tr("hero.eventInfo")}</Body>
    </Pressable>
  );
}

import { Pressable } from "react-native";
import { useEventInfo } from "../api/queries";
import { openEventInfo } from "../nav/links";
import { Body } from "./Text";

/** "Event info ›" in a tournament's header, once the organiser has published the info. */
export function EventInfoLink({ slug }: { slug: string }) {
  const info = useEventInfo(slug);
  if (!info.data) return null;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel="Event info: getting in, hours, directions, contacts"
      onPress={() => openEventInfo(slug)}
      hitSlop={8}
      style={({ pressed }) => pressed && { opacity: 0.6 }}
    >
      <Body tone="blue" size={13} weight="semi">{"Event info ›"}</Body>
    </Pressable>
  );
}

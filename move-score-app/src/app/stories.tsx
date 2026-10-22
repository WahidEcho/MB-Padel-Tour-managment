import { useLocalSearchParams } from "expo-router";
import { StoryViewer } from "../stories/Viewer";

/** Move Score Stories, full screen: `start` = the poster key tapped, `slug` = one event's row (else all events). */
export default function Stories() {
  const { start, slug } = useLocalSearchParams<{ start?: string; slug?: string }>();
  return <StoryViewer start={start} slug={slug} />;
}

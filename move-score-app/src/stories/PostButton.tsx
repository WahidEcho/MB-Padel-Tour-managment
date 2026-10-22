/**
 * "Post to Move Score Stories" in the share step: captures the finished story
 * (the composer's 1080×1920 export, or the card without a photo) and posts it with
 * where it came from. Signed out, it explains that posting needs an account and
 * offers the way to sign in.
 */
import { useState } from "react";
import { ActivityIndicator, Pressable, Text } from "react-native";
import * as Haptics from "expo-haptics";
import type { StoryContextInput } from "@core";
import { ApiError } from "../api/client";
import { session } from "../state/session";
import { F } from "../theme/type";
import { useT } from "../i18n";
import { postStory } from "./api";
import { StoriesGuide } from "./Guide";

export function PostToStoriesButton({ context, capture, disabled, onNote }: { context: StoryContextInput | null; capture: () => Promise<string | null>; disabled?: boolean; onNote: (note: string | null) => void }) {
  const tr = useT();
  const signedIn = session.use((s) => Boolean(s.user));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [ask, setAsk] = useState(false);
  if (!context) return null;
  const post = async () => {
    if (busy || done) return;
    if (!signedIn) return setAsk(true);
    setBusy(true);
    onNote(null);
    try {
      const uri = await capture();
      if (!uri) throw new Error("capture");
      await postStory(uri, context);
      setDone(true);
      onNote(tr("stories.posted"));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setAsk(true);
      else onNote(e instanceof ApiError && e.status ? e.message : tr("stories.postFailed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={done ? tr("stories.posted") : tr("stories.postToStories")}
        accessibilityState={{ disabled: Boolean(disabled || busy), busy }}
        disabled={disabled || busy}
        onPress={() => void post()}
        style={({ pressed }) => ({ minHeight: 48, flexDirection: "row", gap: 8, borderRadius: 18, alignItems: "center", justifyContent: "center", paddingHorizontal: 14, backgroundColor: "#1E6BFF", opacity: disabled ? 0.5 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] })}
      >
        {busy ? <ActivityIndicator color="#FFFFFF" /> : null}
        <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75} style={{ fontFamily: F.bodyBold, fontSize: 15, color: "#FFFFFF" }}>
          {busy ? tr("stories.posting") : done ? `✓ ${tr("stories.posted")}` : tr("stories.postToStories")}
        </Text>
      </Pressable>
      <StoriesGuide mode={ask ? "signIn" : null} signedIn={signedIn} onClose={() => setAsk(false)} />
    </>
  );
}

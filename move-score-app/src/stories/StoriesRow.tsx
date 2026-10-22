/**
 * The row of story circles: "+" (your story) first, then one circle per poster,
 * unseen first (a ball-coloured ring), newest first. On Discover it holds every
 * public event's stories; on an event hub (`slug`) that event's only. Tapping a
 * circle opens the full-screen viewer on that poster.
 */
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { router } from "expo-router";
import { Image } from "expo-image";
import { orderPosters, type MStoryPoster } from "@core";
import { session } from "../state/session";
import { useTheme } from "../theme/ThemeProvider";
import { Body } from "../ui/Text";
import { useT } from "../i18n";
import { useStoriesFeed } from "./api";
import { seenStories } from "./seen";
import { StoriesGuide, type GuideMode } from "./Guide";

const SIZE = 64;

function initials(name: string | null): string {
  return (name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

export function Avatar({ name, url, size }: { name: string | null; url: string | null; size: number }) {
  const { t } = useTheme();
  if (url) return <Image source={{ uri: url }} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: t.surface }} contentFit="cover" transition={0} />;
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: t.surface, alignItems: "center", justifyContent: "center" }}>
      <Body weight="bold" size={size * 0.34}>
        {initials(name) || "MS"}
      </Body>
    </View>
  );
}

function Circle({ label, ring, onPress, a11y, children }: { label: string; ring: string; onPress: () => void; a11y: string; children: React.ReactNode }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={a11y} onPress={onPress} style={({ pressed }) => ({ width: SIZE + 10, alignItems: "center", gap: 5, transform: [{ scale: pressed ? 0.95 : 1 }] })}>
      <View style={{ width: SIZE + 6, height: SIZE + 6, borderRadius: (SIZE + 6) / 2, borderWidth: 2.5, borderColor: ring, alignItems: "center", justifyContent: "center" }}>{children}</View>
      <Body size={11.5} numberOfLines={1} style={{ maxWidth: SIZE + 10, textAlign: "center" }}>
        {label}
      </Body>
    </Pressable>
  );
}

export function StoriesRow({ slug }: { slug?: string }) {
  const { t } = useTheme();
  const tr = useT();
  const signedIn = session.use((s) => Boolean(s.user));
  const seen = seenStories.use((s) => s);
  const feed = useStoriesFeed(slug ?? null);
  const [guide, setGuide] = useState<GuideMode | null>(null);
  const posters: MStoryPoster[] = orderPosters(feed.data?.posters ?? [], seen);
  if (slug && !posters.length) return null;
  const open = (key: string) => router.push({ pathname: "/stories", params: slug ? { start: key, slug } : { start: key } });
  return (
    <View style={{ marginBottom: 16 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingRight: 18 }} style={{ marginHorizontal: -18, paddingLeft: 12 }}>
        <Circle label={tr("stories.yourStory")} ring={t.line} a11y={tr("stories.addA11y")} onPress={() => setGuide(signedIn ? "add" : "signIn")}>
          <View style={{ width: SIZE, height: SIZE, borderRadius: SIZE / 2, backgroundColor: t.chip, alignItems: "center", justifyContent: "center" }}>
            <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: t.ball, alignItems: "center", justifyContent: "center" }}>
              <View style={{ position: "absolute", width: 12, height: 2.5, borderRadius: 2, backgroundColor: t.ballInk }} />
              <View style={{ position: "absolute", width: 2.5, height: 12, borderRadius: 2, backgroundColor: t.ballInk }} />
            </View>
          </View>
        </Circle>
        {posters.map((p) => {
          const unseen = p.stories.some((s) => !seen.has(s.id));
          const name = p.name ?? tr("stories.fan");
          return (
            <Circle key={p.key} label={name} ring={unseen ? t.ball : t.line} a11y={unseen ? tr("stories.circleNewA11y", { name }) : tr("stories.circleA11y", { name })} onPress={() => open(p.key)}>
              <Avatar name={p.name} url={p.avatarUrl} size={SIZE} />
            </Circle>
          );
        })}
      </ScrollView>
      <StoriesGuide mode={guide} signedIn={signedIn} onClose={() => setGuide(null)} />
    </View>
  );
}

/**
 * The full-screen story viewer: progress bars, the poster's name, photo and how
 * long ago; tap the right side for the next story, the left for the one before;
 * hold to pause; swipe down to close. The caption opens the match, tie or event
 * the story came from. Signed in: a single like, Report and Block (others'
 * stories), Delete and the view and like counts (your own). After the last story
 * a short guide shows how to post one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, Text, View, useWindowDimensions } from "react-native";
import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Image } from "expo-image";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { firstUnseen, orderPosters, storyAge, STORY_REPORT_REASONS, STORY_SHOW_MS, type MStory, type MStoryPoster, type StoryReportReason } from "@core";
import { errorMessage } from "../api/client";
import { session } from "../state/session";
import { BALL, BALL_INK } from "../theme/palette";
import { F } from "../theme/type";
import { Sheet } from "../referee/Sheet";
import { Body } from "../ui/Text";
import { Button } from "../ui/Bits";
import { openMatch, openTie, openTournament } from "../nav/links";
import { useT } from "../i18n";
import type { Key } from "../i18n/t";
import { blockStoryPoster, cachedFeed, deleteStory, markStoryViewed, reportStory, setStoryLike, useStoriesFeed } from "./api";
import { markSeen, seenStories } from "./seen";
import { Avatar } from "./StoriesRow";
import { StoriesGuide, type GuideMode } from "./Guide";

const REASON_KEYS: Record<StoryReportReason, Key> = {
  spam: "stories.reasonSpam",
  nudity: "stories.reasonNudity",
  harassment: "stories.reasonHarassment",
  hate: "stories.reasonHate",
  violence: "stories.reasonViolence",
  false: "stories.reasonFalse",
  other: "stories.reasonOther",
};

const TICK = 50;

function confirm(title: string, body: string, ok: string, cancel: string, run: () => void) {
  Alert.alert(title, body, [
    { text: cancel, style: "cancel" },
    { text: ok, style: "destructive", onPress: run },
  ]);
}

export function StoryViewer({ start, slug }: { start: string | undefined; slug: string | undefined }) {
  const tr = useT();
  const insets = useSafeAreaInsets();
  const { width: sw, height: sh } = useWindowDimensions();
  const signedIn = session.use((s) => Boolean(s.user));
  const live = useStoriesFeed(slug ?? null);
  // The order is fixed when the viewer opens, so watching does not reshuffle it.
  const [posters, setPosters] = useState<MStoryPoster[]>(() => orderPosters(cachedFeed(slug ?? null)?.posters ?? [], seenStories.get()));
  useEffect(() => {
    if (!posters.length && live.data?.posters.length) setPosters(orderPosters(live.data.posters, seenStories.get()));
  }, [live.data, posters.length]);

  const [pi, setPi] = useState(0);
  const [si, setSi] = useState(0);
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !posters.length) return;
    started.current = true;
    const i = Math.max(0, posters.findIndex((p) => p.key === start));
    setPi(i);
    setSi(firstUnseen(posters[i]!, seenStories.get()));
  }, [posters, start]);

  const poster = posters[pi];
  const story: MStory | undefined = poster?.stories[si];
  const [elapsed, setElapsed] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [held, setHeld] = useState(false);
  const [sheet, setSheet] = useState<null | "more" | "report">(null);
  const [guide, setGuide] = useState<GuideMode | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [liked, setLiked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const paused = held || sheet !== null || guide !== null || !loaded || busy;

  const close = useCallback(() => (router.canGoBack() ? router.back() : router.replace("/")), []);

  // A new story: start its clock, count it seen (on the phone) and viewed (on the server).
  useEffect(() => {
    if (!story) return;
    setElapsed(0);
    setLoaded(false);
    setNote(null);
    markSeen(story.id);
    markStoryViewed(story.id);
  }, [story]);

  const next = useCallback(() => {
    if (!poster) return;
    if (si + 1 < poster.stories.length) return setSi(si + 1);
    if (pi + 1 < posters.length) {
      setPi(pi + 1);
      setSi(firstUnseen(posters[pi + 1]!, seenStories.get()));
      return;
    }
    // The end of everything: how to post one of your own.
    setGuide("caughtUp");
  }, [poster, si, pi, posters]);

  const prev = useCallback(() => {
    if (si > 0) return setSi(si - 1);
    if (pi > 0) {
      setPi(pi - 1);
      setSi(Math.max(0, posters[pi - 1]!.stories.length - 1));
      return;
    }
    setElapsed(0);
  }, [si, pi, posters]);

  useEffect(() => {
    if (paused || !story) return;
    const id = setInterval(() => setElapsed((e) => e + TICK), TICK);
    return () => clearInterval(id);
  }, [paused, story]);
  useEffect(() => {
    if (elapsed >= STORY_SHOW_MS) next();
  }, [elapsed, next]);

  // A tap is short; holding pauses until the finger lifts.
  const pressedAt = useRef(0);
  const onPressIn = () => {
    pressedAt.current = Date.now();
    setHeld(true);
  };
  const onPressOut = (x: number) => {
    setHeld(false);
    if (Date.now() - pressedAt.current > 250) return;
    if (x < sw / 3) prev();
    else next();
  };

  const swipe = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY(24)
        .failOffsetX([-30, 30])
        .onEnd((e) => {
          if (e.translationY > 110) runOnJS(close)();
        }),
    [close],
  );

  const isLiked = story ? (liked[story.id] ?? story.liked ?? false) : false;
  const needSignIn = () => setGuide("signIn");

  const toggleLike = async () => {
    if (!story) return;
    if (!signedIn) return needSignIn();
    const want = !isLiked;
    setLiked((m) => ({ ...m, [story.id]: want }));
    try {
      await setStoryLike(story.id, want);
    } catch {
      setLiked((m) => ({ ...m, [story.id]: !want }));
    }
  };

  const act = async (work: () => Promise<void>, done: string, after?: () => void) => {
    setBusy(true);
    try {
      await work();
      setNote(done);
      after?.();
    } catch (e) {
      setNote(errorMessage(e) || tr("stories.failed"));
    } finally {
      setBusy(false);
    }
  };

  const openCaption = () => {
    if (!story) return;
    const { matchId, tieId, slug: s } = story.link;
    close();
    setTimeout(() => {
      if (matchId) openMatch(matchId);
      else if (tieId) openTie(tieId);
      else if (s) openTournament(s);
    }, 0);
  };

  /** Drops the current poster from the viewer (blocked) and moves on. */
  const dropPoster = () => {
    const rest = posters.filter((_, i) => i !== pi);
    if (!rest.length) return close();
    setPosters(rest);
    setPi(Math.min(pi, rest.length - 1));
    setSi(0);
  };

  const dropStory = () => {
    if (!poster) return;
    const left = poster.stories.filter((_, i) => i !== si);
    if (!left.length) return dropPoster();
    setPosters(posters.map((p, i) => (i === pi ? { ...p, stories: left } : p)));
    setSi(Math.min(si, left.length - 1));
  };

  if (!poster || !story) {
    return (
      <View style={{ flex: 1, backgroundColor: "#000", alignItems: "center", justifyContent: "center" }}>
        <StatusBar style="light" />
        {live.isLoading ? <ActivityIndicator color="#FFFFFF" /> : <Button kind="ghost" label={tr("stories.close")} onPress={close} />}
      </View>
    );
  }

  const age = storyAge(story.createdAt);
  const ago = age.unit === "now" ? tr("stories.ageNow") : age.unit === "m" ? tr("stories.ageMinutes", { n: age.n }) : tr("stories.ageHours", { n: age.n });
  const name = poster.name ?? tr("stories.fan");
  // The picture at 9:16, as large as fits.
  const W = Math.min(sw, ((sh - insets.top - insets.bottom) * 9) / 16);
  const H = (W * 16) / 9;

  return (
    <GestureDetector gesture={swipe}>
      <View style={{ flex: 1, backgroundColor: "#000" }}>
        <StatusBar style="light" />
        <View style={{ position: "absolute", top: insets.top, left: (sw - W) / 2, width: W, height: H, borderRadius: 14, overflow: "hidden", backgroundColor: "#0a1022" }}>
          <Image
            source={{ uri: story.imageUrl }}
            style={{ width: W, height: H }}
            contentFit="cover"
            transition={0}
            onLoad={() => setLoaded(true)}
            onError={() => setLoaded(true)}
            accessibilityLabel={story.caption ?? tr("stories.title")}
          />
          {!loaded ? <ActivityIndicator color="#FFFFFF" style={{ position: "absolute", top: H / 2 - 10, alignSelf: "center" }} /> : null}
          {/* Tap zones: left third back, the rest forward; holding anywhere pauses. */}
          <Pressable
            style={{ position: "absolute", left: 0, top: 0, width: W, height: H }}
            onPressIn={onPressIn}
            onPressOut={(e) => onPressOut(e.nativeEvent.locationX)}
            accessibilityRole="button"
            accessibilityLabel={tr("stories.next")}
            accessibilityActions={[{ name: "activate" }, { name: "increment", label: tr("stories.next") }, { name: "decrement", label: tr("stories.previous") }, { name: "escape", label: tr("stories.close") }]}
            onAccessibilityAction={(e) => {
              const n = e.nativeEvent.actionName;
              if (n === "decrement") prev();
              else if (n === "escape") close();
              else next();
            }}
          />
        </View>

        {/* Progress bars and the poster. */}
        <View pointerEvents="box-none" style={{ position: "absolute", top: insets.top + 8, left: (sw - W) / 2 + 10, width: W - 20, gap: 10 }}>
          <View style={{ flexDirection: "row", gap: 4 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {poster.stories.map((s, i) => (
              <View key={s.id} style={{ flex: 1, height: 2.5, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.35)", overflow: "hidden" }}>
                <View style={{ height: 2.5, backgroundColor: "#FFFFFF", width: i < si ? "100%" : i > si ? "0%" : `${Math.min(100, (elapsed / STORY_SHOW_MS) * 100)}%` }} />
              </View>
            ))}
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Avatar name={poster.name} url={poster.avatarUrl} size={34} />
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={{ fontFamily: F.bodyBold, fontSize: 14, color: "#FFFFFF" }}>
                {name}
                <Text style={{ fontFamily: F.bodyMedium, color: "rgba(255,255,255,0.7)" }}>{`  ${ago}`}</Text>
              </Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel={tr("stories.more")} hitSlop={10} onPress={() => (signedIn ? setSheet("more") : needSignIn())} style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}>
              <Text style={{ fontFamily: F.bodyBold, fontSize: 20, color: "#FFFFFF", marginTop: -8 }}>…</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={tr("stories.close")} hitSlop={10} onPress={close} style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}>
              <View style={{ position: "absolute", width: 20, height: 2.5, borderRadius: 2, backgroundColor: "#FFFFFF", transform: [{ rotate: "45deg" }] }} />
              <View style={{ position: "absolute", width: 20, height: 2.5, borderRadius: 2, backgroundColor: "#FFFFFF", transform: [{ rotate: "-45deg" }] }} />
            </Pressable>
          </View>
        </View>

        {/* Caption (where it came from), the like, and the poster's own counts. */}
        <View pointerEvents="box-none" style={{ position: "absolute", bottom: insets.bottom + 14, left: 16, right: 16, gap: 10 }}>
          {note ? (
            <Text accessibilityRole="alert" style={{ alignSelf: "center", fontFamily: F.bodySemi, fontSize: 13, color: "#FFFFFF", backgroundColor: "rgba(0,0,0,0.75)", borderRadius: 12, paddingHorizontal: 12, paddingVertical: 6, overflow: "hidden", textAlign: "center" }}>
              {note}
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            {story.caption ? (
              <Pressable accessibilityRole="link" accessibilityLabel={tr("stories.openCaptionA11y", { caption: story.caption })} onPress={openCaption} style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", borderRadius: 16, paddingHorizontal: 12, paddingVertical: 9 }}>
                <Text numberOfLines={1} style={{ fontFamily: F.bodySemi, fontSize: 13, color: "#FFFFFF" }}>
                  {story.caption} ›
                </Text>
              </Pressable>
            ) : (
              <View style={{ flex: 1 }} />
            )}
            {story.mine ? (
              <Text style={{ fontFamily: F.bodySemi, fontSize: 12.5, color: "#FFFFFF", backgroundColor: "rgba(0,0,0,0.6)", borderRadius: 14, paddingHorizontal: 10, paddingVertical: 8, overflow: "hidden" }}>
                {`♥ ${tr("stories.likes", { count: story.likes ?? 0 })} · ${tr("stories.views", { count: story.views ?? 0 })}`}
              </Text>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={isLiked ? tr("stories.unlike") : tr("stories.like")}
                accessibilityState={{ selected: isLiked }}
                hitSlop={8}
                onPress={() => void toggleLike()}
                style={({ pressed }) => ({ width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center", backgroundColor: isLiked ? BALL : "rgba(0,0,0,0.55)", transform: [{ scale: pressed ? 0.9 : 1 }] })}
              >
                <Text style={{ fontSize: 22, color: isLiked ? BALL_INK : "#FFFFFF", marginTop: -2 }}>{isLiked ? "♥" : "♡"}</Text>
              </Pressable>
            )}
          </View>
        </View>

        <Sheet open={sheet === "more"} onClose={() => setSheet(null)} title={tr("stories.title")}>
          {story.mine ? (
            <Button
              kind="danger"
              label={tr("stories.deleteStory")}
              onPress={() => {
                setSheet(null);
                confirm(tr("stories.deleteStory"), tr("stories.deleteConfirm"), tr("stories.deleteStory"), tr("stories.cancel"), () => void act(() => deleteStory(story.id), "", dropStory));
              }}
            />
          ) : (
            <>
              <Button kind="ghost" label={tr("stories.report")} onPress={() => setSheet("report")} />
              <Button
                kind="danger"
                label={tr("stories.block")}
                onPress={() => {
                  setSheet(null);
                  confirm(tr("stories.block"), tr("stories.blockConfirm"), tr("stories.block"), tr("stories.cancel"), () => void act(() => blockStoryPoster(story.id), tr("stories.blocked"), dropPoster));
                }}
              />
            </>
          )}
          <Body tone="ink2" size={12.5} style={{ textAlign: "center" }}>
            {tr("stories.contact")}
          </Body>
          <Button kind="ghost" label={tr("stories.cancel")} onPress={() => setSheet(null)} />
        </Sheet>

        <Sheet open={sheet === "report"} onClose={() => setSheet(null)} title={tr("stories.report")} tall>
          <Body weight="bold">{tr("stories.reportTitle")}</Body>
          {STORY_REPORT_REASONS.map((r) => (
            <Button
              key={r}
              kind="ghost"
              label={tr(REASON_KEYS[r])}
              onPress={() => {
                setSheet(null);
                void act(() => reportStory(story.id, r), tr("stories.reported"));
              }}
            />
          ))}
          <Body tone="ink2" size={12.5} style={{ textAlign: "center" }}>
            {tr("stories.contact")}
          </Body>
        </Sheet>

        <StoriesGuide
          mode={guide}
          signedIn={signedIn}
          onClose={() => {
            const wasEnd = guide === "caughtUp";
            setGuide(null);
            if (wasEnd) close();
          }}
        />
      </View>
    </GestureDetector>
  );
}

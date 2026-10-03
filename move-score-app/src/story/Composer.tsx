/**
 * Step 2, compose: the photo fills a 9:16 story (drag and pinch it; double-tap
 * to reset), the Move Score sticker sits over it (drag, pinch, turn; tap for
 * light or dark), and the layout styles are a swipe or a tap away on the rail.
 * Step 3, share: a 1080×1920 capture goes to the share sheet or to Stories.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View, useWindowDimensions, type LayoutChangeEvent } from "react-native";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { Directions, Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { FadeOut, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BALL, BALL_INK } from "../theme/palette";
import { F } from "../theme/type";
import { Chrome, Scrims, Sticker, flagUrl } from "./Stickers";
import { ExportStage, type ExportSpec } from "./Export";
import { BackIcon, CloseIcon, ShareIcon } from "./Icons";
import { shareImage, shareToStories } from "./share";
import { DESIGN_W, clampPhoto, coverSize, layoutsFor, type LayoutId, type Photo, type StoryInfo, type Tone } from "./model";

const TOP_BAR = 56;
const RAIL = 50;
const ACTIONS = 56;
const GAP = 12;

const buzz = () => void Haptics.selectionAsync().catch(() => {});
const lift = () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});

export function Composer({ info, photo, calm, storiesOn, onRetake, onClose }: { info: StoryInfo; photo: Photo; calm: boolean; storiesOn: boolean; onRetake: () => void; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const { width: sw, height: sh } = useWindowDimensions();
  const layouts = useMemo(() => layoutsFor(info), [info]);
  const [layoutId, setLayoutId] = useState<LayoutId>(info.kind === "pass" && info.pass ? "pass" : "scoreboard");
  const layout = layouts.find((l) => l.id === layoutId) ?? layouts[0]!;
  const [tones, setTones] = useState<Record<LayoutId, Tone>>({ scoreboard: "dark", pass: "dark", minimal: "dark", ticket: "dark" });
  const tone = tones[layout.id];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState(true);
  const [spec, setSpec] = useState<ExportSpec | null>(null);
  const pending = useRef<((uri: string | null) => void) | null>(null);

  // The biggest 9:16 canvas that fits between the bars.
  const availH = sh - insets.top - insets.bottom - TOP_BAR - RAIL - ACTIONS - GAP * 3;
  const W = Math.max(160, Math.floor(Math.min(sw - 24, (availH * 9) / 16)));
  const H = Math.round((W * 16) / 9);
  const u = W / DESIGN_W;
  const base = useMemo(() => coverSize(photo.width, photo.height, W, H), [photo.width, photo.height, W, H]);

  // Photo pose: offset as a fraction of the canvas width, zoom over "cover".
  const ptx = useSharedValue(0);
  const pty = useSharedValue(0);
  const ps = useSharedValue(1);
  // Sticker pose: centre as fractions of the canvas, size, turn.
  const sx = useSharedValue(layout.pose.x);
  const sy = useSharedValue(layout.pose.y);
  const ss = useSharedValue(layout.pose.s);
  const sr = useSharedValue(layout.pose.r);
  const mw = useSharedValue(0);
  const mh = useSharedValue(0);
  const snapped = useSharedValue(0);

  useEffect(() => {
    const p = layout.pose;
    const to = (v: number) => (calm ? v : withSpring(v, { damping: 18, stiffness: 170 }));
    sx.value = to(p.x);
    sy.value = to(p.y);
    ss.value = to(p.s);
    sr.value = to(p.r);
  }, [layout, calm, sx, sy, ss, sr]);

  // Flags and the wordmark are fetched once, before anything is captured.
  useEffect(() => {
    const urls = (info.sides ?? []).map((s) => flagUrl(s.iso2)).filter((x): x is string => Boolean(x));
    if (urls.length) void Image.prefetch(urls).catch(() => false);
  }, [info.sides]);

  useEffect(() => {
    const t = setTimeout(() => setHint(false), 4500);
    return () => clearTimeout(t);
  }, []);

  const toggleTone = useCallback(() => {
    if (layout.id === "pass") return;
    buzz();
    setTones((t) => ({ ...t, [layout.id]: t[layout.id] === "dark" ? "light" : "dark" }));
  }, [layout.id]);

  const step = useCallback(
    (d: 1 | -1) => {
      const i = layouts.findIndex((l) => l.id === layout.id);
      const next = layouts[(i + d + layouts.length) % layouts.length]!;
      buzz();
      setLayoutId(next.id);
    },
    [layouts, layout.id],
  );

  const resetPhoto = useCallback(() => {
    ptx.value = calm ? 0 : withSpring(0);
    pty.value = calm ? 0 : withSpring(0);
    ps.value = calm ? 1 : withSpring(1);
  }, [calm, ptx, pty, ps]);

  const photoGesture = useMemo(() => {
    const pan = Gesture.Pan()
      .averageTouches(true)
      .onChange((e) => {
        const c = clampPhoto({ tx: ptx.value + e.changeX / W, ty: pty.value + e.changeY / W, s: ps.value }, base, W, H);
        ptx.value = c.tx;
        pty.value = c.ty;
      });
    const pinch = Gesture.Pinch().onChange((e) => {
      const c = clampPhoto({ tx: ptx.value, ty: pty.value, s: ps.value * e.scaleChange }, base, W, H);
      ps.value = c.s;
      ptx.value = c.tx;
      pty.value = c.ty;
    });
    const reset = Gesture.Tap()
      .numberOfTaps(2)
      .onEnd(() => {
        runOnJS(resetPhoto)();
      });
    return Gesture.Race(reset, Gesture.Simultaneous(pan, pinch));
  }, [W, H, base, ptx, pty, ps, resetPhoto]);

  const stickerGesture = useMemo(() => {
    const pan = Gesture.Pan()
      .averageTouches(true)
      .onStart(() => {
        runOnJS(lift)();
      })
      .onChange((e) => {
        let x = Math.max(0.04, Math.min(0.96, sx.value + e.changeX / W));
        // Snaps to the centre line, with a tick, the moment it gets close.
        if (Math.abs(x - 0.5) < 0.014) {
          x = 0.5;
          if (!snapped.value) {
            snapped.value = 1;
            runOnJS(buzz)();
          }
        } else snapped.value = 0;
        sx.value = x;
        sy.value = Math.max(0.05, Math.min(0.95, sy.value + e.changeY / H));
      })
      .onFinalize(() => {
        snapped.value = 0;
      });
    const pinch = Gesture.Pinch().onChange((e) => {
      ss.value = Math.max(0.45, Math.min(2.2, ss.value * e.scaleChange));
    });
    const turn = Gesture.Rotation()
      .onChange((e) => {
        sr.value += e.rotationChange;
      })
      .onEnd(() => {
        // Nearly straight becomes straight.
        if (Math.abs(sr.value) < 0.06) sr.value = withTiming(0, { duration: 120 });
      });
    const tap = Gesture.Tap().onEnd(() => {
      runOnJS(toggleTone)();
    });
    return Gesture.Race(tap, Gesture.Simultaneous(pan, pinch, turn));
  }, [W, H, sx, sy, ss, sr, snapped, toggleTone]);

  const railGesture = useMemo(
    () =>
      Gesture.Exclusive(
        Gesture.Fling()
          .direction(Directions.LEFT)
          .onEnd(() => {
            runOnJS(step)(1);
          }),
        Gesture.Fling()
          .direction(Directions.RIGHT)
          .onEnd(() => {
            runOnJS(step)(-1);
          }),
      ),
    [step],
  );

  const photoStyle = useAnimatedStyle(() => ({ transform: [{ translateX: ptx.value * W }, { translateY: pty.value * W }, { scale: ps.value }] }));
  const stickerStyle = useAnimatedStyle(() => ({
    opacity: mw.value ? 1 : 0,
    transform: [{ translateX: sx.value * W - mw.value / 2 }, { translateY: sy.value * H - mh.value / 2 }, { rotate: `${sr.value}rad` }, { scale: ss.value }],
  }));
  const guideStyle = useAnimatedStyle(() => ({ opacity: withTiming(snapped.value ? 0.9 : 0, { duration: 120 }) }));
  const measure = (e: LayoutChangeEvent) => {
    mw.value = e.nativeEvent.layout.width;
    mh.value = e.nativeEvent.layout.height;
  };

  const exportStory = () =>
    new Promise<string | null>((resolve) => {
      pending.current = resolve;
      setSpec({
        info,
        layout: layout.id,
        tone,
        photo,
        photoPose: { tx: ptx.value, ty: pty.value, s: ps.value },
        stickerPose: { x: sx.value, y: sy.value, s: ss.value, r: sr.value },
      });
    });
  const onExported = useCallback((uri: string | null) => {
    setSpec(null);
    pending.current?.(uri);
    pending.current = null;
  }, []);

  const share = async (to: "sheet" | "stories") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const uri = await exportStory();
      if (!uri) {
        setError("The story couldn't be made. Try again.");
        return;
      }
      const r = to === "stories" ? await shareToStories(uri) : await shareImage(uri);
      if (r === "shared") void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: "#000" }}>
      {spec ? <ExportStage spec={spec} onDone={onExported} /> : null}
      {/* Covers the export copy while it is drawn underneath. */}
      <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, backgroundColor: "#000" }} />

      <View style={{ height: TOP_BAR, marginTop: insets.top, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Retake the photo" hitSlop={8} onPress={onRetake} style={{ flexDirection: "row", alignItems: "center", gap: 2, paddingVertical: 8, paddingRight: 10 }}>
          <BackIcon />
          <Text style={{ fontFamily: F.bodySemi, fontSize: 15, color: "#FFFFFF" }}>Retake</Text>
        </Pressable>
        <Text accessibilityRole="header" style={{ fontFamily: F.bodyBold, fontSize: 12, letterSpacing: 1.8, color: "#9AA4B8", textTransform: "uppercase" }}>
          Your story
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Close" hitSlop={8} onPress={onClose} style={{ width: 40, height: 40, alignItems: "flex-end", justifyContent: "center" }}>
          <CloseIcon />
        </Pressable>
      </View>

      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <View
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={`Story preview, ${layout.label} style. ${info.a11y}.`}
          accessibilityHint="Swipe up or down to change the style. Drag or pinch to move the photo and the sticker."
          accessibilityActions={[{ name: "increment", label: "Next style" }, { name: "decrement", label: "Previous style" }, { name: "magicTap", label: "Share" }]}
          onAccessibilityAction={(e) => {
            if (e.nativeEvent.actionName === "increment") step(1);
            else if (e.nativeEvent.actionName === "decrement") step(-1);
            else if (e.nativeEvent.actionName === "magicTap") void share("sheet");
          }}
          style={{ width: W, height: H, borderRadius: 18 * u, overflow: "hidden", backgroundColor: "#0a1022" }}
        >
          <GestureDetector gesture={photoGesture}>
            <View style={{ position: "absolute", left: 0, top: 0, width: W, height: H }}>
              <Animated.View style={[{ position: "absolute", left: (W - base.w) / 2, top: (H - base.h) / 2, width: base.w, height: base.h }, photoStyle]}>
                <Image source={{ uri: photo.uri }} style={{ width: "100%", height: "100%" }} contentFit="cover" transition={calm ? 0 : 200} />
              </Animated.View>
            </View>
          </GestureDetector>
          <Scrims W={W} H={H} layout={layout.id} />
          <Chrome W={W} H={H} u={u} info={info} layout={layout.id} />
          <Animated.View pointerEvents="none" style={[{ position: "absolute", left: W / 2 - 0.5, top: 0, width: 1, height: H, backgroundColor: BALL }, guideStyle]} />
          <GestureDetector gesture={stickerGesture}>
            <Animated.View onLayout={measure} style={[{ position: "absolute", left: 0, top: 0 }, stickerStyle]}>
              <Sticker layout={layout.id} info={info} u={u} tone={tone} />
            </Animated.View>
          </GestureDetector>
          {hint ? (
            <Animated.View exiting={calm ? undefined : FadeOut.duration(400)} pointerEvents="none" style={{ position: "absolute", top: H * 0.17, alignSelf: "center", backgroundColor: "rgba(0,0,0,0.55)", borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8, maxWidth: W - 32 }}>
              <Text style={{ fontFamily: F.bodySemi, fontSize: 12, lineHeight: 17, color: "#FFFFFF", textAlign: "center" }}>
                {layout.id === "pass" ? "Drag and pinch the photo or the pass" : "Drag and pinch the photo or the sticker · tap the sticker for light or dark"}
              </Text>
            </Animated.View>
          ) : null}
          {busy ? (
            <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, width: W, height: H, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.35)" }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "rgba(0,0,0,0.7)", borderRadius: 16, paddingHorizontal: 16, paddingVertical: 10 }}>
                <ActivityIndicator color="#FFFFFF" />
                <Text style={{ fontFamily: F.bodySemi, fontSize: 14, color: "#FFFFFF" }}>Making your story…</Text>
              </View>
            </View>
          ) : null}
        </View>
      </View>

      <GestureDetector gesture={railGesture}>
        <View style={{ height: RAIL, marginTop: GAP, marginHorizontal: 12, flexDirection: "row", gap: 6, alignItems: "center" }} accessibilityRole="tablist">
          {layouts.map((l) => {
            const on = l.id === layout.id;
            return (
              <Pressable
                key={l.id}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${l.label} style`}
                accessibilityHint={l.hint}
                onPress={() => {
                  if (!on) {
                    buzz();
                    setLayoutId(l.id);
                  }
                }}
                style={({ pressed }) => ({ flex: 1, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: on ? BALL : "rgba(255,255,255,0.10)", borderWidth: 1, borderColor: on ? BALL : "rgba(255,255,255,0.14)", transform: [{ scale: pressed ? 0.96 : 1 }] })}
              >
                <Text numberOfLines={1} style={{ fontFamily: F.bodyBold, fontSize: 13, color: on ? BALL_INK : "#FFFFFF" }}>
                  {l.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </GestureDetector>

      <View style={{ height: ACTIONS, marginTop: GAP, marginBottom: insets.bottom + GAP, marginHorizontal: 12, flexDirection: "row", gap: 8 }}>
        {storiesOn ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Share to Instagram Stories" disabled={busy} onPress={() => void share("stories")} style={({ pressed }) => ({ flex: 1, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.12)", borderWidth: 1, borderColor: "rgba(255,255,255,0.18)", opacity: busy ? 0.5 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] })}>
            <Text style={{ fontFamily: F.bodyBold, fontSize: 15, color: "#FFFFFF" }}>To Stories</Text>
          </Pressable>
        ) : null}
        <Pressable accessibilityRole="button" accessibilityLabel="Share your story" accessibilityHint="Opens the share sheet: Instagram, WhatsApp, Messages or Save Image" disabled={busy} onPress={() => void share("sheet")} style={({ pressed }) => ({ flex: storiesOn ? 1 : 2, flexDirection: "row", gap: 8, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: BALL, opacity: busy ? 0.6 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] })}>
          {busy ? <ActivityIndicator color={BALL_INK} /> : <ShareIcon color={BALL_INK} />}
          <Text style={{ fontFamily: F.bodyBold, fontSize: 16, color: BALL_INK }}>Share</Text>
        </Pressable>
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={{ position: "absolute", bottom: insets.bottom + ACTIONS + RAIL + GAP * 3, alignSelf: "center", fontFamily: F.bodySemi, fontSize: 13, color: "#FFFFFF", backgroundColor: "rgba(229,19,58,0.9)", borderRadius: 12, paddingHorizontal: 12, paddingVertical: 6, overflow: "hidden" }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

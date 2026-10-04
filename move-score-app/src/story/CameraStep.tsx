/**
 * Step 1, "I'm here": a full-screen camera with the score sticker already in
 * the frame, so the fan lines the shot up around it. Front / back, flash,
 * a shutter with a haptic, the library one tap away. No camera permission
 * (refused, or no camera at all) falls back to the library with a plain message.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions, type CameraType, type FlashMode } from "expo-camera";
import * as Haptics from "expo-haptics";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSequence, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BALL, BALL_INK } from "../theme/palette";
import { F } from "../theme/type";
import { openSettings, prepare } from "./photo";
import type { Photo } from "./model";
import { CloseIcon, FlashIcon, FlipIcon, LibraryIcon } from "./Icons";

const FLASH_NEXT: Record<FlashMode, FlashMode> = { off: "auto", auto: "on", on: "off", screen: "off" };
const FLASH_LABEL: Record<FlashMode, string> = { off: "Flash off", auto: "Flash auto", on: "Flash on", screen: "Flash on" };

function Round({ label, onPress, children, size = 44, disabled }: { label: string; onPress: () => void; children: ReactNode; size?: number; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => ({ width: size, height: size, borderRadius: size / 2, backgroundColor: "rgba(0,0,0,0.42)", borderWidth: 1, borderColor: "rgba(255,255,255,0.24)", alignItems: "center", justifyContent: "center", opacity: disabled ? 0.4 : 1, transform: [{ scale: pressed ? 0.94 : 1 }] })}
    >
      {children}
    </Pressable>
  );
}

export function CameraStep({ overlay, onPhoto, onLibrary, onClose, onNoPhoto, calm }: { overlay: ReactNode; onPhoto: (p: Photo) => void; onLibrary: () => void; onClose: () => void; onNoPhoto: () => void; calm: boolean }) {
  const insets = useSafeAreaInsets();
  const [perm, ask] = useCameraPermissions();
  const cam = useRef<CameraView>(null);
  const [facing, setFacing] = useState<CameraType>("back");
  const [flash, setFlash] = useState<FlashMode>("off");
  // `started`: the session is running. iOS reports that once per mount (a flip only swaps the
  // lens), so a flip must not wait for it again; Android re-reports it once the new lens is open.
  const [started, setStarted] = useState(false);
  const [switching, setSwitching] = useState(false);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ready = started && !switching;
  const [busy, setBusy] = useState(false);
  const shooting = useRef(false);
  const [failed, setFailed] = useState(false);
  const blink = useSharedValue(0);
  const blinkStyle = useAnimatedStyle(() => ({ opacity: blink.value }));

  // Ask once, the first time; a refusal is not asked again here (the fallback says how).
  useEffect(() => {
    if (perm && !perm.granted && perm.status === "undetermined" && perm.canAskAgain) void ask();
  }, [perm, ask]);

  useEffect(() => () => {
    if (settle.current) clearTimeout(settle.current);
  }, []);
  const settled = () => {
    if (settle.current) clearTimeout(settle.current);
    settle.current = null;
    setSwitching(false);
  };
  const flip = () => {
    void Haptics.selectionAsync().catch(() => {});
    // A short pause while the lens swaps; the camera's ready event ends it early, the timer always does.
    setSwitching(true);
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(settled, 600);
    setFacing((f) => (f === "back" ? "front" : "back"));
  };
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      runOnJS(flip)();
    });

  const shoot = async () => {
    if (!cam.current || !ready || shooting.current) return;
    shooting.current = true;
    setBusy(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    if (!calm) blink.value = withSequence(withTiming(0.85, { duration: 60 }), withTiming(0, { duration: 260 }));
    try {
      const shot = await cam.current.takePictureAsync({ quality: 0.9, exif: false });
      if (!shot?.uri) throw new Error("no photo");
      onPhoto(await prepare({ uri: shot.uri, width: shot.width, height: shot.height }));
    } catch {
      setFailed(true);
      setBusy(false);
      shooting.current = false;
    }
  };

  const denied = perm && !perm.granted && perm.status !== "undetermined";
  if (denied || failed) {
    return (
      <View style={{ flex: 1, backgroundColor: "#000", paddingTop: insets.top + 12, paddingBottom: insets.bottom + 20, paddingHorizontal: 24 }}>
        <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
          <Round label="Close" onPress={onClose}>
            <CloseIcon />
          </Round>
        </View>
        <View style={{ flex: 1, justifyContent: "center", gap: 14 }} accessibilityLiveRegion="polite">
          <Text style={{ fontFamily: F.display, fontSize: 26, lineHeight: 26, color: "#FFFFFF", textTransform: "uppercase" }}>{failed ? "The camera didn't take that" : "The camera is off"}</Text>
          <Text style={{ fontFamily: F.body, fontSize: 15, lineHeight: 21, color: "#C9D0DE" }}>
            {failed
              ? "Something stopped the photo. Pick one from your library instead, or try the camera again."
              : Platform.OS === "web"
                ? "This browser didn't give Move Score the camera. Pick a photo from your library instead."
                : perm?.canAskAgain
                  ? "Move Score needs the camera to take your story photo. Pick one from your library instead, or allow the camera."
                  : "Move Score isn't allowed to use the camera. Pick a photo from your library instead, or turn the camera on in Settings."}
          </Text>
          <Pressable accessibilityRole="button" onPress={onLibrary} style={({ pressed }) => ({ marginTop: 8, backgroundColor: BALL, borderRadius: 16, paddingVertical: 15, alignItems: "center", transform: [{ scale: pressed ? 0.98 : 1 }] })}>
            <Text style={{ fontFamily: F.bodyBold, fontSize: 15, color: BALL_INK }}>Choose from library</Text>
          </Pressable>
          {failed ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                // A fresh viewfinder: wait for it to report ready again.
                setStarted(false);
                setFailed(false);
              }}
              style={{ paddingVertical: 12, alignItems: "center" }}
            >
              <Text style={{ fontFamily: F.bodySemi, fontSize: 14, color: "#FFFFFF" }}>Try the camera again</Text>
            </Pressable>
          ) : Platform.OS !== "web" ? (
            <Pressable accessibilityRole="button" onPress={() => (perm?.canAskAgain ? void ask() : openSettings())} style={{ paddingVertical: 12, alignItems: "center" }}>
              <Text style={{ fontFamily: F.bodySemi, fontSize: 14, color: "#FFFFFF" }}>{perm?.canAskAgain ? "Allow the camera" : "Open Settings"}</Text>
            </Pressable>
          ) : null}
          <Pressable accessibilityRole="button" onPress={onNoPhoto} style={{ paddingVertical: 8, alignItems: "center" }}>
            <Text style={{ fontFamily: F.bodySemi, fontSize: 14, color: "#9AA4B8" }}>Share without photo</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: "#000" }}>
      {perm?.granted ? (
        <GestureDetector gesture={doubleTap}>
          <View style={StyleSheet.absoluteFill} accessible={false}>
            <CameraView
              ref={cam}
              style={StyleSheet.absoluteFill}
              facing={facing}
              flash={facing === "back" ? flash : "off"}
              mirror={facing === "front"}
              mode="picture"
              animateShutter={false}
              onCameraReady={() => {
                setStarted(true);
                settled();
              }}
              onMountError={() => setFailed(true)}
              accessibilityLabel={`Camera viewfinder, ${facing === "front" ? "front" : "back"} camera`}
            />
          </View>
        </GestureDetector>
      ) : (
        <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}>
          <ActivityIndicator color="#FFFFFF" />
        </View>
      )}
      {/* The sticker as it will sit in the story, so the shot is framed around it. */}
      <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: insets.top + 70, bottom: insets.bottom + 180, alignItems: "center", justifyContent: "flex-end", opacity: 0.94 }}>
        {overlay}
      </View>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: "#FFFFFF" }, blinkStyle]} />
      <View style={{ position: "absolute", top: insets.top + 10, left: 16, right: 16, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Round label="Close" onPress={onClose}>
          <CloseIcon />
        </Round>
        <View style={{ backgroundColor: "rgba(0,0,0,0.42)", borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 7 }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: BALL }} />
          <Text allowFontScaling={false} style={{ fontFamily: F.bodyBold, fontSize: 12, letterSpacing: 1.8, color: "#FFFFFF", textTransform: "uppercase" }}>
            I&apos;m here
          </Text>
        </View>
        {facing === "back" ? (
          <Round label={FLASH_LABEL[flash]} onPress={() => setFlash((f) => FLASH_NEXT[f])}>
            <FlashIcon mode={flash === "screen" ? "on" : flash} />
          </Round>
        ) : (
          <View style={{ width: 44 }} />
        )}
      </View>
      <View style={{ position: "absolute", left: 0, right: 0, bottom: insets.bottom + 18, alignItems: "center", gap: 14 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", width: "100%", paddingHorizontal: 34 }}>
          <Round label="Choose from library" onPress={onLibrary} size={50}>
            <LibraryIcon />
          </Round>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Take the photo"
            disabled={!ready || busy}
            onPress={() => void shoot()}
            style={({ pressed }) => ({ width: 80, height: 80, borderRadius: 40, borderWidth: 5, borderColor: "#FFFFFF", alignItems: "center", justifyContent: "center", opacity: ready ? 1 : 0.5, transform: [{ scale: pressed ? 0.92 : 1 }] })}
          >
            {busy ? <ActivityIndicator color={BALL_INK} /> : <View style={{ width: 62, height: 62, borderRadius: 31, backgroundColor: BALL }} />}
          </Pressable>
          <Round label={facing === "back" ? "Switch to the front camera" : "Switch to the back camera"} onPress={flip} size={50}>
            <FlipIcon />
          </Round>
        </View>
        <Pressable accessibilityRole="button" onPress={onNoPhoto} hitSlop={8} style={{ paddingVertical: 6, paddingHorizontal: 14, borderRadius: 14, backgroundColor: "rgba(0,0,0,0.35)" }}>
          <Text allowFontScaling={false} style={{ fontFamily: F.bodySemi, fontSize: 13, color: "#FFFFFF" }}>
            Share without photo
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

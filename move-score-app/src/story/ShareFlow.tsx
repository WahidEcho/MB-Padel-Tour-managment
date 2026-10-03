/**
 * Every share in the app runs through here: match, tie and pass.
 *   start   – the card as it is, with "I'm here" (camera), "Choose photo" and "Share without photo";
 *   camera  – take the shot with the sticker already in frame;
 *   compose – the photo story (Composer), then the share sheet.
 */
import { useEffect, useRef, useState } from "react";
import { BackHandler, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { captureRef } from "react-native-view-shot";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useConfig } from "../api/queries";
import { useTheme } from "../theme/ThemeProvider";
import { Body } from "../ui/Text";
import { Button } from "../ui/Bits";
import { CameraStep } from "./CameraStep";
import { ClassicCard, CARD_H, CARD_W } from "./ClassicCard";
import { Composer } from "./Composer";
import { CameraIcon, CloseIcon, LibraryIcon } from "./Icons";
import { ScoreSticker } from "./Stickers";
import { canShareToStories, shareImage, shareToStories } from "./share";
import { pickFromLibrary } from "./photo";
import { DESIGN_W, type Photo } from "./model";
import type { StoryState } from "./useStoryInfo";

type Step = "start" | "camera" | "compose";

export function ShareFlow({ state }: { state: StoryState }) {
  const { t, calm } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: sw, height: sh } = useWindowDimensions();
  const cfg = useConfig();
  const storiesOn = canShareToStories(cfg.data?.flags.share_stories !== false);
  const [step, setStep] = useState<Step>("start");
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [from, setFrom] = useState<"camera" | "library">("camera");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const card = useRef<View>(null);
  const info = state.info;

  // Android back steps back through the flow before it closes the screen.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (step === "compose") {
        setStep(from === "camera" ? "camera" : "start");
        return true;
      }
      if (step === "camera") {
        setStep("start");
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [step, from]);

  const library = async () => {
    setNote(null);
    try {
      const p = await pickFromLibrary();
      if (!p) return;
      setPhoto(p);
      setFrom("library");
      setStep("compose");
    } catch {
      setNote("Your photos couldn't be opened. Try again, or take a photo instead.");
    }
  };

  const shareCard = async (to: "sheet" | "stories") => {
    setBusy(true);
    try {
      const uri = await captureRef(card, { format: "png", quality: 1, width: 1080, height: 1920, result: "tmpfile" });
      if (to === "stories") await shareToStories(uri);
      else await shareImage(uri, "image/png");
    } catch {
      setNote("The card couldn't be made. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (step === "camera" && info) {
    const u = Math.min(sw, 430) / DESIGN_W;
    return (
      <>
        <StatusBar style="light" />
        <CameraStep
          calm={calm}
          overlay={<ScoreSticker info={info} u={u * 0.86} tone="dark" />}
          onPhoto={(p) => {
            setPhoto(p);
            setFrom("camera");
            setStep("compose");
          }}
          onLibrary={() => void library()}
          onClose={() => router.back()}
          onNoPhoto={() => setStep("start")}
        />
      </>
    );
  }

  if (step === "compose" && info && photo) {
    return (
      <>
        <StatusBar style="light" />
        <Composer info={info} photo={photo} calm={calm} storiesOn={storiesOn} onRetake={() => (from === "camera" ? setStep("camera") : void library())} onClose={() => router.back()} />
      </>
    );
  }

  // The card shrinks on short screens so the three choices always fit under it.
  const k = Math.min(1, (sh - insets.top - insets.bottom - 300) / CARD_H);
  const dark = t.scheme === "dark";
  return (
    <View style={{ flex: 1, backgroundColor: dark ? "rgba(0,0,8,0.84)" : "rgba(246,247,249,0.94)", alignItems: "center", justifyContent: "center", gap: 18, paddingTop: insets.top, paddingBottom: insets.bottom }}>
      <Pressable style={StyleSheet.absoluteFill} onPress={() => router.back()} accessibilityLabel="Close" accessibilityRole="button" />
      <Pressable accessibilityRole="button" accessibilityLabel="Close" hitSlop={10} onPress={() => router.back()} style={{ position: "absolute", top: insets.top + 12, right: 16, width: 40, height: 40, borderRadius: 20, backgroundColor: t.chip, alignItems: "center", justifyContent: "center" }}>
        <CloseIcon color={t.ink} />
      </Pressable>
      <View style={{ width: CARD_W * k, height: CARD_H * k }} accessible accessibilityLabel={info ? `Share card. ${info.a11y}` : "Share card"}>
        <View style={{ width: CARD_W, height: CARD_H, transformOrigin: "0 0", transform: [{ scale: k }] }}>
          <View ref={card} collapsable={false}>
            <ClassicCard info={info} problem={state.problem} onRetry={state.retry} />
          </View>
        </View>
      </View>
      <View style={{ width: Math.min(sw - 40, 340), gap: 8 }}>
        <Button label="I'm here · add a photo" icon={<CameraIcon color={t.btnInk} />} onPress={() => setStep("camera")} disabled={!info || busy} />
        <Button kind="ghost" label="Choose from library" icon={<LibraryIcon color={t.ink} size={20} />} onPress={() => void library()} disabled={!info || busy} />
        <Button kind="ghost" label="Share without photo" onPress={() => void shareCard("sheet")} disabled={!info || busy} />
        {storiesOn ? (
          <Body tone="blue" weight="semi" size={13} accessibilityRole="button" onPress={() => (busy || !info ? undefined : void shareCard("stories"))} style={{ textAlign: "center", marginTop: 4 }}>
            Card to Instagram Stories
          </Body>
        ) : null}
        {note ? (
          <Body tone="ink2" size={13} accessibilityRole="alert" style={{ textAlign: "center", marginTop: 4 }}>
            {note}
          </Body>
        ) : null}
      </View>
    </View>
  );
}

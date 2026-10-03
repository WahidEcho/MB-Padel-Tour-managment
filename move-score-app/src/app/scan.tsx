import { useRef, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { router } from "expo-router";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BALL } from "../theme/palette";
import { useTheme } from "../theme/ThemeProvider";
import { Body, Display, Eyebrow } from "../ui/Text";
import { Button } from "../ui/Bits";
import { checkInFeedback, checkInWith, parseMatchLink, parseVenueLink, unlockWith } from "../pass/unlock";
import { useFeaturedGroup } from "../api/featured";
import { ApiError, OFFLINE_MESSAGE } from "../api/client";

const buzz = (kind: "success" | "warning" | "error") => {
  const type = kind === "success" ? Haptics.NotificationFeedbackType.Success : kind === "warning" ? Haptics.NotificationFeedbackType.Warning : Haptics.NotificationFeedbackType.Error;
  void Haptics.notificationAsync(type).catch(() => {});
};

/**
 * One scanner for both codes: the gate's venue code (unlocks the on-site pass and
 * stamps today) and a match's check-in code (court TV corner or printed at the
 * court: the match goes on the pass with its points).
 */
export default function Scan() {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const [perm, ask] = useCameraPermissions();
  const [msg, setMsg] = useState<{ text: string; tone: "success" | "warning" | "error" } | null>(null);
  const [staffCode, setStaffCode] = useState("");
  const busy = useRef(false);
  const group = useFeaturedGroup();
  const done = (text: string, tone: "success" | "warning" = "success") => {
    buzz(tone);
    setMsg({ text, tone });
    setTimeout(() => router.replace("/pass"), tone === "success" ? 1100 : 1600);
  };
  // The camera reports the same code many times a second: a code the server just
  // refused is not sent again until the screen shows a new one, or 10 seconds pass.
  const rejected = useRef<{ key: string; at: number } | null>(null);
  const attempt = async (key: string, fromCamera: boolean, run: () => Promise<void>) => {
    if (busy.current) return;
    const last = rejected.current;
    if (fromCamera && last && last.key === key && Date.now() - last.at < 10_000) return;
    busy.current = true;
    try {
      await run();
      rejected.current = null;
    } catch (e) {
      // No connection is not a refusal: the next frame may try again.
      if (e instanceof ApiError && e.status !== 0) rejected.current = { key, at: Date.now() };
      setTimeout(() => (busy.current = false), 1500);
    }
  };
  const tryVenue = (groupSlug: string, code: string, fromCamera = false) =>
    attempt(`v:${groupSlug}:${code.toUpperCase()}`, fromCamera, async () => {
      try {
        const r = await unlockWith(groupSlug, code);
        done(r.stampedDay ? `Stamped · ${r.stampedDay}` : "On-site pass unlocked");
      } catch (e) {
        buzz("error");
        setMsg({ text: e instanceof ApiError ? e.message : OFFLINE_MESSAGE, tone: "error" });
        throw e;
      }
    });
  const tryMatch = (link: { matchId: string; c?: string; p?: string }) =>
    attempt(`m:${link.matchId}:${link.c ?? link.p}`, true, async () => {
      try {
        const r = await checkInWith(link);
        const f = checkInFeedback(r);
        done(f.text, f.haptic === "success" ? "success" : "warning");
      } catch (e) {
        const f = e instanceof ApiError ? checkInFeedback({ ...((e.body as object | null) ?? {}), error: e.message }) : { text: OFFLINE_MESSAGE, haptic: "error" as const };
        buzz(f.haptic);
        setMsg({ text: f.text, tone: f.haptic === "success" ? "success" : f.haptic });
        throw e;
      }
    });
  const tone = msg?.tone === "success" ? BALL : msg?.tone === "warning" ? "#FFC266" : "#FF8A80";
  return (
    <View style={{ flex: 1, backgroundColor: "#000" }}>
      {perm?.granted ? (
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={({ data }) => {
            const match = parseMatchLink(data);
            if (match) return void tryMatch(match);
            const link = parseVenueLink(data);
            if (link) void tryVenue(link.groupSlug, link.code, true);
          }}
        />
      ) : null}
      <View style={{ flex: 1, paddingTop: insets.top + 12, paddingHorizontal: 22, paddingBottom: insets.bottom + 20, justifyContent: "space-between" }}>
        <View style={{ gap: 6 }}>
          <Eyebrow style={{ color: BALL }}>My pass</Eyebrow>
          <Display size={26} style={{ color: "#E8ECF4" }}>Scan the gate or a match</Display>
          <Body size={13} style={{ color: "#9AA4B8" }}>The gate code stamps your day. The code on the court screen checks you in to that match and adds to your score.</Body>
        </View>
        <View style={{ alignSelf: "center", width: 240, height: 240, borderRadius: 28, borderWidth: 3, borderColor: msg ? tone : BALL }} />
        <View style={{ gap: 10 }}>
          {msg ? (
            <Body weight="bold" accessibilityRole="alert" style={{ color: msg.tone === "success" ? "#E8ECF4" : tone, textAlign: "center" }}>
              {msg.text}
            </Body>
          ) : null}
          {!perm?.granted && <Button label="Allow the camera" onPress={() => void ask()} />}
          {group ? (
            <View style={{ flexDirection: "row", gap: 8 }}>
              <TextInput
                value={staffCode}
                onChangeText={setStaffCode}
                placeholder="Or the 6-digit code from staff"
                placeholderTextColor="#6B7590"
                keyboardType="number-pad"
                maxLength={6}
                accessibilityLabel="Six-digit venue code"
                style={{ flex: 1, backgroundColor: "rgba(255,255,255,0.08)", borderRadius: 14, paddingHorizontal: 14, color: "#E8ECF4", fontSize: 16 }}
              />
              <Button label="Use" disabled={staffCode.length !== 6} onPress={() => void tryVenue(group.slug, staffCode)} />
            </View>
          ) : null}
          <Button kind="ghost" label="Close" onPress={() => router.back()} style={{ backgroundColor: "rgba(255,255,255,0.08)" }} />
        </View>
      </View>
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderColor: t.ball, borderWidth: 0 }]} />
    </View>
  );
}

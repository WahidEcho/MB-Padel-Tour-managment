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
import { parseVenueLink, unlockWith } from "../pass/unlock";
import { useFeaturedGroup } from "../api/featured";
import { ApiError } from "../api/client";

/** Scans the code on the gate screen to unlock the on-site pass and stamp today. */
export default function Scan() {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const [perm, ask] = useCameraPermissions();
  const [msg, setMsg] = useState<string | null>(null);
  const [staffCode, setStaffCode] = useState("");
  const busy = useRef(false);
  const group = useFeaturedGroup();
  const done = (text: string) => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    setMsg(text);
    setTimeout(() => router.replace("/pass"), 900);
  };
  // The camera reports the same code many times a second: a code the server just
  // refused is not sent again until the gate shows a new one, or 10 seconds pass.
  const rejected = useRef<{ key: string; at: number } | null>(null);
  const tryCode = async (groupSlug: string, code: string, fromCamera = false) => {
    if (busy.current) return;
    const key = `${groupSlug}:${code.toUpperCase()}`;
    const last = rejected.current;
    if (fromCamera && last && last.key === key && Date.now() - last.at < 10_000) return;
    busy.current = true;
    try {
      const r = await unlockWith(groupSlug, code);
      rejected.current = null;
      done(r.stampedDay ? `Stamped · ${r.stampedDay}` : "On-site pass unlocked");
    } catch (e) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      setMsg(e instanceof ApiError ? e.message : "No connection. Try again in a moment.");
      // No connection is not a refusal: the next frame may try again.
      if (e instanceof ApiError && e.status !== 0) rejected.current = { key, at: Date.now() };
      setTimeout(() => (busy.current = false), 1500);
    }
  };
  return (
    <View style={{ flex: 1, backgroundColor: "#000" }}>
      {perm?.granted ? (
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={({ data }) => {
            const link = parseVenueLink(data);
            if (link) void tryCode(link.groupSlug, link.code, true);
          }}
        />
      ) : null}
      <View style={{ flex: 1, paddingTop: insets.top + 12, paddingHorizontal: 22, paddingBottom: insets.bottom + 20, justifyContent: "space-between" }}>
        <View style={{ gap: 6 }}>
          <Eyebrow style={{ color: BALL }}>On-site pass</Eyebrow>
          <Display size={26} style={{ color: "#E8ECF4" }}>Scan the code at the gate</Display>
        </View>
        <View style={{ alignSelf: "center", width: 240, height: 240, borderRadius: 28, borderWidth: 3, borderColor: BALL }} />
        <View style={{ gap: 10 }}>
          {msg ? <Body weight="bold" style={{ color: "#E8ECF4", textAlign: "center" }}>{msg}</Body> : null}
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
              <Button label="Use" disabled={staffCode.length !== 6} onPress={() => void tryCode(group.slug, staffCode)} />
            </View>
          ) : null}
          <Button kind="ghost" label="Close" onPress={() => router.back()} style={{ backgroundColor: "rgba(255,255,255,0.08)" }} />
        </View>
      </View>
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderColor: t.ball, borderWidth: 0 }]} />
    </View>
  );
}

import { useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { parseCourtLink } from "@core";
import { BALL } from "../../theme/palette";
import { Body, Display, Eyebrow } from "../../ui/Text";
import { Button } from "../../ui/Bits";
import { pendingCode, signInWithCode } from "../../referee/courtSignIn";

/**
 * "Scan court QR": the QR on a court's referee table (https://tour.mbeg.org/r#<code>,
 * migration 0034) signs this phone in to that court, replacing the previous referee
 * session. Matches of the old court with unsent points or still unfinished on this
 * phone stay reachable with the old court's code until they are sent and finished.
 */
export default function ScanCourt() {
  const insets = useSafeAreaInsets();
  const [perm, ask] = useCameraPermissions();
  const [msg, setMsg] = useState<string | null>(null);
  const busy = useRef(false);
  const last = useRef<{ code: string; at: number } | null>(null);
  const done = (court: string | null, carried: number) => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    setMsg(`${court ? `Signed in · ${court}` : "Signed in"}${carried ? ` · the old court's ${carried === 1 ? "match stays" : `${carried} matches stay`} yours until sent and finished` : ""}`);
    setTimeout(() => router.replace("/referee"), 1200);
  };
  const onScan = async (data: string) => {
    const code = parseCourtLink(data);
    if (!code || busy.current) return;
    // The camera reports the same code many times a second: once per 8 seconds.
    if (last.current && last.current.code === code && Date.now() - last.current.at < 8_000) return;
    last.current = { code, at: Date.now() };
    busy.current = true;
    setMsg("Signing in…");
    const r = await signInWithCode(code);
    busy.current = false;
    if (r.ok) return done(r.court, r.carried);
    if (r.pinRequired) {
      // The court is right; who is on it comes next (migration 0035).
      pendingCode.set(code, r.court ?? null, Boolean(r.master));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      router.replace("/referee/pin");
      return;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
    setMsg(r.message);
  };
  return (
    <View style={{ flex: 1, backgroundColor: "#000" }}>
      {perm?.granted ? (
        <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={({ data }) => void onScan(data)} />
      ) : null}
      <View style={{ flex: 1, paddingTop: insets.top + 12, paddingHorizontal: 22, paddingBottom: insets.bottom + 20, justifyContent: "space-between" }}>
        <View style={{ gap: 6 }}>
          <Eyebrow style={{ color: BALL }}>Referee</Eyebrow>
          <Display size={26} style={{ color: "#E8ECF4" }}>Scan the court QR</Display>
          <Body size={13} style={{ color: "#9AA4B8" }}>The QR code on the court&apos;s referee table signs this phone in to that court. You then see only its matches today.</Body>
        </View>
        <View pointerEvents="none" style={{ alignSelf: "center", width: 240, height: 240, flexShrink: 1, borderRadius: 28, borderWidth: 3, borderColor: BALL }} />
        <View style={{ gap: 10 }}>
          {msg ? <Body weight="bold" accessibilityRole="alert" style={{ color: "#E8ECF4", textAlign: "center" }}>{msg}</Body> : null}
          {!perm?.granted && <Button label="Allow the camera" onPress={() => void ask()} />}
          <Button kind="ghost" label="Close" onPress={() => router.back()} style={{ backgroundColor: "rgba(255,255,255,0.08)" }} />
        </View>
      </View>
    </View>
  );
}

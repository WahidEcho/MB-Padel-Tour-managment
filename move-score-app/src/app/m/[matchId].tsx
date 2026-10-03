import { useEffect, useState } from "react";
import { View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import { checkInFeedback, checkInWith } from "../../pass/unlock";
import { Body, Display } from "../../ui/Text";
import { useTheme } from "../../theme/ThemeProvider";
import { ApiError } from "../../api/client";

/** A match's check-in code opened with the phone's own camera: the link lands here. */
export default function MatchCheckInLink() {
  const { t } = useTheme();
  const { matchId, c, p } = useLocalSearchParams<{ matchId: string; c?: string; p?: string }>();
  const [msg, setMsg] = useState("Checking you in…");
  useEffect(() => {
    if (!c && !p) {
      router.replace({ pathname: "/match/[id]", params: { id: matchId } });
      return;
    }
    const feel = (h: "success" | "warning" | "error") =>
      void Haptics.notificationAsync(h === "success" ? Haptics.NotificationFeedbackType.Success : h === "warning" ? Haptics.NotificationFeedbackType.Warning : Haptics.NotificationFeedbackType.Error).catch(() => {});
    checkInWith({ matchId, c, p })
      .then((r) => {
        const f = checkInFeedback(r);
        feel(f.haptic);
        setMsg(f.text);
        setTimeout(() => router.replace("/pass"), 1200);
      })
      .catch((e) => {
        const f = e instanceof ApiError ? checkInFeedback({ ...((e.body as object | null) ?? {}), error: e.message }) : { text: "No connection. Open My pass and scan again.", haptic: "error" as const };
        feel(f.haptic);
        setMsg(f.text);
      });
  }, [matchId, c, p]);
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: t.floor, padding: 24, gap: 10 }}>
      <Display size={24}>Match check-in</Display>
      <Body tone="ink2" style={{ textAlign: "center" }} accessibilityRole="alert">{msg}</Body>
    </View>
  );
}

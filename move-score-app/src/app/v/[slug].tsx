import { useEffect, useState } from "react";
import { View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { unlockWith } from "../../pass/unlock";
import { Body, Display } from "../../ui/Text";
import { useTheme } from "../../theme/ThemeProvider";
import { ApiError } from "../../api/client";

/** The venue code opened with the phone's own camera: the link lands here. */
export default function VenueLink() {
  const { t } = useTheme();
  const { slug, c } = useLocalSearchParams<{ slug: string; c?: string }>();
  const [msg, setMsg] = useState("Stamping your pass…");
  useEffect(() => {
    if (!c) {
      router.replace("/pass");
      return;
    }
    unlockWith(slug, c)
      .then(() => router.replace("/pass"))
      .catch((e) => setMsg(e instanceof ApiError ? e.message : "No connection. Open My pass and scan again."));
  }, [slug, c]);
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: t.floor, padding: 24, gap: 10 }}>
      <Display size={24}>On-site pass</Display>
      <Body tone="ink2">{msg}</Body>
    </View>
  );
}

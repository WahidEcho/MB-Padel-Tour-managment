import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { unlockWith } from "../../pass/unlock";
import { Body, Display } from "../../ui/Text";
import { LoadState } from "../../ui/LoadState";
import { useTheme } from "../../theme/ThemeProvider";
import { ApiError } from "../../api/client";

/** The venue code opened with the phone's own camera: the link lands here. */
export default function VenueLink() {
  const { t } = useTheme();
  const { slug, c } = useLocalSearchParams<{ slug: string; c?: string }>();
  const [msg, setMsg] = useState("Stamping your pass…");
  const [offline, setOffline] = useState(false);
  const stamp = useCallback(async () => {
    if (!c) return;
    try {
      await unlockWith(slug, c);
      router.replace("/pass");
    } catch (e) {
      // No answer at all: say so and stamp again once the phone is back online.
      if (e instanceof ApiError && e.status !== 0) {
        setOffline(false);
        setMsg(e.message);
      } else setOffline(true);
    }
  }, [slug, c]);
  useEffect(() => {
    if (!c) {
      router.replace("/pass");
      return;
    }
    void stamp();
  }, [c, stamp]);
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: t.floor, padding: 24, gap: 10 }}>
      <Display size={24}>On-site pass</Display>
      {offline ? <LoadState compact kind="offline" onRetry={stamp} what="your pass stamp" /> : <Body tone="ink2">{msg}</Body>}
    </View>
  );
}

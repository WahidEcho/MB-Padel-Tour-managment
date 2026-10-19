import { useEffect, useState } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import * as Linking from "expo-linking";
import { parseCoachLink } from "@core";
import { useTheme } from "../theme/ThemeProvider";
import { Body, Display } from "../ui/Text";
import { Button } from "../ui/Bits";
import { signInCoach } from "../coach/session";

/**
 * A team coach card's QR link (https://tour.mbeg.org/c#<code>, or movescore://c#<code> from
 * the web page's "Open in Move Score") opened in the app: signs this phone in as the team's
 * coach and opens My team. The code is in the #fragment, read from the full URL.
 */
export default function CoachLink() {
  const { t } = useTheme();
  const url = Linking.useLinkingURL();
  const [msg, setMsg] = useState("Opening your team…");
  const code = url ? parseCoachLink(url) : null;
  useEffect(() => {
    if (!code) return;
    let live = true;
    void signInCoach(code).then((r) => {
      if (!live) return;
      if (r.ok) {
        setMsg(`Signed in · ${r.team}`);
        setTimeout(() => router.replace("/coach/team"), 700);
      } else setMsg(r.message);
    });
    return () => {
      live = false;
    };
  }, [code]);
  const shown = url && !code ? "This link has no team code. Open Account → Staff → Coach sign-in and type the code on the card." : msg;
  return (
    <View style={{ flex: 1, justifyContent: "center", backgroundColor: t.floor, padding: 24, gap: 12 }}>
      <Display size={24}>Team coach</Display>
      <Body tone="ink2" accessibilityRole="alert">{shown}</Body>
      <Button kind="ghost" label="Coach sign-in" onPress={() => router.replace("/coach")} />
    </View>
  );
}

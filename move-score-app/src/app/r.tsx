import { useEffect, useState } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import * as Linking from "expo-linking";
import { parseCourtLink } from "@core";
import { useTheme } from "../theme/ThemeProvider";
import { Body, Display } from "../ui/Text";
import { Button } from "../ui/Bits";
import { signInWithCode } from "../referee/courtSignIn";

/**
 * A court QR link (https://tour.mbeg.org/r#<code>, or movescore://r#<code> from the
 * web page's "Open in Move Score") opened in the app: the referee is switched to that
 * court at once. The phone keeps the old court's unsent or unfinished matches
 * (src/referee/courtSignIn.ts). The code is in the #fragment, read from the full URL.
 */
export default function CourtLink() {
  const { t } = useTheme();
  const url = Linking.useLinkingURL();
  const [msg, setMsg] = useState("Opening the court…");
  const code = url ? parseCourtLink(url) : null;
  useEffect(() => {
    if (!code) return;
    let live = true;
    void signInWithCode(code).then((r) => {
      if (!live) return;
      if (r.ok) {
        setMsg(`${r.court ? `Signed in · ${r.court}` : "Signed in"}${r.carried ? ` · you keep the old court's ${r.carried === 1 ? "match" : `${r.carried} matches`} until sent and finished` : ""}`);
        setTimeout(() => router.replace("/referee"), 900);
      } else setMsg(r.message);
    });
    return () => {
      live = false;
    };
  }, [code]);
  const shown = url && !code ? "This link has no court code. Scan the court's QR code from Referee → Scan court QR." : msg;
  return (
    <View style={{ flex: 1, justifyContent: "center", backgroundColor: t.floor, padding: 24, gap: 12 }}>
      <Display size={24}>Court referee</Display>
      <Body tone="ink2" accessibilityRole="alert">{shown}</Body>
      <Button kind="ghost" label="Referee home" onPress={() => router.replace("/referee")} />
    </View>
  );
}

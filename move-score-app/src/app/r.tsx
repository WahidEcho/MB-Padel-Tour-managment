import { useEffect, useState } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import * as Linking from "expo-linking";
import { parseCourtLink } from "@core";
import { useTheme } from "../theme/ThemeProvider";
import { Body, Display } from "../ui/Text";
import { Button } from "../ui/Bits";
import { pendingCode, signInWithCode } from "../referee/courtSignIn";
import { tr as trNow, useT } from "../i18n";

/**
 * A court QR link (https://tour.mbeg.org/r#<code>, or movescore://r#<code> from the
 * web page's "Open in Move Score") opened in the app: the referee is switched to that
 * court at once. The phone keeps the old court's unsent or unfinished matches
 * (src/referee/courtSignIn.ts). The code is in the #fragment, read from the full URL.
 */
export default function CourtLink() {
  const { t } = useTheme();
  const tr = useT();
  const url = Linking.useLinkingURL();
  const [msg, setMsg] = useState(() => trNow("referee.openingCourt"));
  const code = url ? parseCourtLink(url) : null;
  useEffect(() => {
    if (!code) return;
    let live = true;
    void signInWithCode(code).then((r) => {
      if (!live) return;
      if (!r.ok && r.pinRequired) {
        pendingCode.set(code, r.court ?? null, Boolean(r.master), r.referees ?? []);
        router.replace("/referee/pin");
        return;
      }
      if (r.ok) {
        setMsg(`${r.court ? trNow("referee.signedInCourt", { court: r.court }) : trNow("referee.signedIn")}${r.carried ? ` · ${trNow("referee.carriedStays", { count: r.carried })}` : ""}`);
        setTimeout(() => router.replace("/referee"), 900);
      } else setMsg(r.message);
    });
    return () => {
      live = false;
    };
  }, [code]);
  const shown = url && !code ? tr("referee.noCourtCode") : msg;
  return (
    <View style={{ flex: 1, justifyContent: "center", backgroundColor: t.floor, padding: 24, gap: 12 }}>
      <Display size={24}>{tr("referee.courtReferee")}</Display>
      <Body tone="ink2" accessibilityRole="alert">{shown}</Body>
      <Button kind="ghost" label={tr("referee.refereeHome")} onPress={() => router.replace("/referee")} />
    </View>
  );
}

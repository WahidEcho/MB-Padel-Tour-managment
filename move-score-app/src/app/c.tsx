import { useEffect, useState } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import * as Linking from "expo-linking";
import { parseCoachLink } from "@core";
import { useTheme } from "../theme/ThemeProvider";
import { Body, Display } from "../ui/Text";
import { Button } from "../ui/Bits";
import { signInCoach } from "../coach/session";
import { tr as trNow, useT } from "../i18n";

/**
 * A team coach card's QR link (https://tour.mbeg.org/c#<code>, or movescore://c#<code> from
 * the web page's "Open in Move Score") opened in the app: signs this phone in as the team's
 * coach and opens My team. The code is in the #fragment, read from the full URL.
 */
export default function CoachLink() {
  const { t } = useTheme();
  const tr = useT();
  const url = Linking.useLinkingURL();
  const [msg, setMsg] = useState(() => trNow("coach.openingTeam"));
  const code = url ? parseCoachLink(url) : null;
  useEffect(() => {
    if (!code) return;
    let live = true;
    void signInCoach(code).then((r) => {
      if (!live) return;
      if (r.ok) {
        setMsg(trNow("coach.signedInTeam", { team: r.team }));
        setTimeout(() => router.replace("/coach/team"), 700);
      } else setMsg(r.message);
    });
    return () => {
      live = false;
    };
  }, [code]);
  const shown = url && !code ? tr("coach.noTeamCode") : msg;
  return (
    <View style={{ flex: 1, justifyContent: "center", backgroundColor: t.floor, padding: 24, gap: 12 }}>
      <Display size={24}>{tr("coach.teamCoach")}</Display>
      <Body tone="ink2" accessibilityRole="alert">{shown}</Body>
      <Button kind="ghost" label={tr("coach.coachSignIn")} onPress={() => router.replace("/coach")} />
    </View>
  );
}

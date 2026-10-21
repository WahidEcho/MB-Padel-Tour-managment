import { useEffect, useState } from "react";
import { router } from "expo-router";
import { refreshAccount } from "../../auth/email";
import { session } from "../../state/session";
import { Screen } from "../../ui/Screen";
import { BackHeader } from "../../ui/Header";
import { Body, Display, Eyebrow } from "../../ui/Text";
import { Button } from "../../ui/Bits";
import { useT } from "../../i18n";

/**
 * movescore://auth/confirmed — where the web confirm and reset pages send the
 * phone back to. Signed out: offers to sign in. A player finishing their
 * registration: checks it with the server and says it is done.
 */
export default function Confirmed() {
  const tr = useT();
  const user = session.use((s) => s.user);
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    if (!session.get().user) return;
    refreshAccount()
      .catch(() => undefined)
      .finally(() => setChecked(true));
  }, []);

  if (user) {
    const complete = user.registrationComplete !== false;
    return (
      <Screen tabs={false}>
        <BackHeader label={tr("ui.account")} fallback="/account" />
        <Eyebrow tone="live">Move Score</Eyebrow>
        <Display size={28} style={{ marginTop: 6 }}>{complete ? tr("auth.emailConfirmed") : checked ? tr("auth.almostThere") : tr("auth.checking")}</Display>
        <Body tone="ink2" size={14} style={{ marginTop: 8 }}>
          {complete
            ? tr("auth.accountReady")
            : checked
              ? tr("auth.notSeenYet")
              : tr("auth.oneMoment")}
        </Body>
        {complete || checked ? (
          <Button label={complete ? tr("common.done") : tr("auth.completeRegistrationShort")} onPress={() => router.replace(complete ? "/account" : "/auth/complete")} style={{ marginTop: 18 }} />
        ) : null}
      </Screen>
    );
  }
  return (
    <Screen tabs={false}>
      <BackHeader label={tr("ui.account")} fallback="/account" />
      <Eyebrow tone="live">Move Score</Eyebrow>
      <Display size={28} style={{ marginTop: 6 }}>{tr("auth.emailConfirmed")}</Display>
      <Body tone="ink2" size={14} style={{ marginTop: 8 }}>{tr("auth.signInToFinish")}</Body>
      <Button label={tr("auth.signIn")} onPress={() => router.replace({ pathname: "/auth/email", params: { mode: "signin" } })} style={{ marginTop: 18 }} />
    </Screen>
  );
}

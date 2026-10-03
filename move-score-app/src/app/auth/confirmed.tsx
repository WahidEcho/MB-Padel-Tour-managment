import { useEffect, useState } from "react";
import { router } from "expo-router";
import { refreshAccount } from "../../auth/email";
import { session } from "../../state/session";
import { Screen } from "../../ui/Screen";
import { BackHeader } from "../../ui/Header";
import { Body, Display, Eyebrow } from "../../ui/Text";
import { Button } from "../../ui/Bits";

/**
 * movescore://auth/confirmed — where the web confirm and reset pages send the
 * phone back to. Signed out: offers to sign in. A player finishing their
 * registration: checks it with the server and says it is done.
 */
export default function Confirmed() {
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
        <BackHeader label="Account" fallback="/account" />
        <Eyebrow tone="live">Move Score</Eyebrow>
        <Display size={28} style={{ marginTop: 6 }}>{complete ? "Email confirmed" : checked ? "Almost there" : "Checking…"}</Display>
        <Body tone="ink2" size={14} style={{ marginTop: 8 }}>
          {complete
            ? "Your account is ready. You stay signed in on this phone until you sign out."
            : checked
              ? "We haven't seen the confirmation yet. Open the newest email and tap its link, or enter its code."
              : "One moment."}
        </Body>
        {complete || checked ? (
          <Button label={complete ? "Done" : "Complete registration"} onPress={() => router.replace(complete ? "/account" : "/auth/complete")} style={{ marginTop: 18 }} />
        ) : null}
      </Screen>
    );
  }
  return (
    <Screen tabs={false}>
      <BackHeader label="Account" fallback="/account" />
      <Eyebrow tone="live">Move Score</Eyebrow>
      <Display size={28} style={{ marginTop: 6 }}>Email confirmed</Display>
      <Body tone="ink2" size={14} style={{ marginTop: 8 }}>Sign in with your email and password to finish.</Body>
      <Button label="Sign in" onPress={() => router.replace({ pathname: "/auth/email", params: { mode: "signin" } })} style={{ marginTop: 18 }} />
    </Screen>
  );
}

import { useState } from "react";
import { TextInput, View } from "react-native";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { useTheme } from "../../theme/ThemeProvider";
import { Screen } from "../../ui/Screen";
import { BackHeader } from "../../ui/Header";
import { Body, Display, Eyebrow } from "../../ui/Text";
import { Button, Card } from "../../ui/Bits";
import { session } from "../../state/session";
import { lastCoachRefusal, signInCoach, signOutCoach } from "../../coach/session";
import { TeamLine } from "../../coach/ui";

/**
 * Account → Staff → Coach sign-in (migration 0037): the code on the team's coach card.
 * The head coach and every assistant use the same code, each on their own phone.
 */
export default function CoachSignIn() {
  const { t } = useTheme();
  const coach = session.use((s) => s.coach);
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(coach ? null : lastCoachRefusal());
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!code.trim() || busy) return;
    setBusy(true);
    setErr(null);
    const r = await signInCoach(code);
    setBusy(false);
    if (r.ok) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setCode("");
      router.replace("/coach/team");
      return;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
    setErr(r.message);
  };
  return (
    <Screen tabs={false}>
      <BackHeader label="Account" fallback="/account" />
      <Eyebrow tone="live">Team coach</Eyebrow>
      <Display size={30} style={{ marginTop: 6 }}>{coach ? "My team" : "Coach sign-in"}</Display>
      {coach ? (
        <Card style={{ marginTop: 16, gap: 12 }}>
          <TeamLine team={coach.team} size={26} />
          <Body tone="ink2" size={13}>{coach.event.name}</Body>
          <Button label="Open My team" onPress={() => router.push("/coach/team")} />
          <Button kind="ghost" label="Sign out on this phone" onPress={() => void signOutCoach()} />
        </Card>
      ) : (
        <Card style={{ marginTop: 16, gap: 12 }}>
          <Body tone="ink2" size={14}>Type the code on your team&apos;s coach card, or scan its QR code with the phone camera. Every coach of the team uses the same code.</Body>
          <TextInput
            value={code}
            onChangeText={(v) => setCode(v.toUpperCase().slice(0, 20))}
            autoCapitalize="characters"
            autoCorrect={false}
            accessibilityLabel="Team code"
            placeholder="XXXX-XXXX-XXXX"
            placeholderTextColor={t.ink3}
            onSubmitEditing={() => void submit()}
            style={{ backgroundColor: t.chip, borderColor: err ? t.live : t.line, borderWidth: 1, borderRadius: 16, paddingVertical: 16, paddingHorizontal: 14, color: t.ink, fontSize: 22, letterSpacing: 3, textAlign: "center" }}
          />
          {err ? <Body tone="live" size={13} accessibilityRole="alert">{err}</Body> : null}
          <Button label={busy ? "Checking…" : "Sign in"} disabled={!code.trim() || busy} onPress={() => void submit()} />
          <View style={{ gap: 4 }}>
            <Body tone="ink3" size={12}>Read only: your team&apos;s ties, line-ups once the referee enters them, live scores, match logs and results, with alerts on this phone.</Body>
          </View>
        </Card>
      )}
    </Screen>
  );
}

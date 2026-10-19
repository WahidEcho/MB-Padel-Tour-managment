import { useState } from "react";
import { TextInput, View } from "react-native";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { PIN_LENGTH } from "@core";
import { pendingCode, signInWithCode } from "../../referee/courtSignIn";
import { useTheme } from "../../theme/ThemeProvider";
import { Screen } from "../../ui/Screen";
import { BackHeader } from "../../ui/Header";
import { Body, Display, Eyebrow } from "../../ui/Text";
import { Button, Card } from "../../ui/Bits";

/**
 * Step two of a court (or master) code sign-in (migration 0035): the referee's own
 * 4-digit PIN. The code it goes with is held in memory only (pendingCode), from the
 * typed field, the court QR or a /r link. The court's code says which court; the PIN
 * says who is on it.
 */
export default function RefereePin() {
  const { t } = useTheme();
  const waiting = pendingCode.get();
  const [pin, setPin] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (value = pin) => {
    if (!waiting || value.length !== PIN_LENGTH || busy) return;
    setBusy(true);
    setErr(null);
    const r = await signInWithCode(waiting.code, value);
    setBusy(false);
    if (r.ok) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      router.replace(r.master ? "/referee/master" : "/referee");
      return;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
    setPin("");
    setErr(r.message);
  };
  return (
    <Screen tabs={false}>
      <BackHeader label="Referee" />
      <Eyebrow tone="live">{waiting?.master ? "Master referee" : "Court referee"}</Eyebrow>
      <Display size={30} style={{ marginTop: 6 }}>{waiting?.master ? "Your PIN" : (waiting?.court ?? "Your PIN")}</Display>
      {!waiting ? (
        <Card style={{ marginTop: 16, gap: 10 }}>
          <Body>Scan the court QR or type the court code first.</Body>
          <Button label="Referee home" onPress={() => router.replace("/referee")} />
        </Card>
      ) : (
        <Card style={{ marginTop: 16, gap: 12 }}>
          <Body tone="ink2" size={14}>Enter your own 4-digit referee PIN from the organiser. It tells the desk who is on {waiting.master ? "duty" : "this court"}.</Body>
          <TextInput
            value={pin}
            onChangeText={(v) => {
              const next = v.replace(/\D/g, "").slice(0, PIN_LENGTH);
              setPin(next);
              if (next.length === PIN_LENGTH) void submit(next);
            }}
            autoFocus
            secureTextEntry
            keyboardType="number-pad"
            maxLength={PIN_LENGTH}
            accessibilityLabel="Referee PIN"
            placeholder="••••"
            placeholderTextColor={t.ink3}
            style={{ backgroundColor: t.chip, borderColor: err ? t.live : t.line, borderWidth: 1, borderRadius: 16, paddingVertical: 18, color: t.ink, fontSize: 34, letterSpacing: 18, textAlign: "center" }}
          />
          {err ? <Body tone="live" size={13} accessibilityRole="alert">{err}</Body> : null}
          <Button label={busy ? "Checking…" : "Sign in"} disabled={pin.length !== PIN_LENGTH || busy} onPress={() => void submit()} />
          <View style={{ alignItems: "center" }}>
            <Body tone="blue" size={13} onPress={() => { pendingCode.clear(); router.replace("/referee"); }}>Use another code</Body>
          </View>
        </Card>
      )}
    </Screen>
  );
}

import { useEffect, useState } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { isStrongPassword, isValidEmail, normalizeEmail } from "@core";
import { errorMessage } from "../../api/client";
import { completeRegistration, refreshAccount, verifyEmailCode } from "../../auth/email";
import { EmailField, Field, PasswordChecklist, PasswordField } from "../../auth/fields";
import { session } from "../../state/session";
import { Screen } from "../../ui/Screen";
import { BackHeader } from "../../ui/Header";
import { Body, Display, Eyebrow } from "../../ui/Text";
import { Button, Card } from "../../ui/Bits";
import { useT } from "../../i18n";

/**
 * "Complete your registration": a player who signed in with their code adds an
 * email and a password. Supabase emails a confirmation link (and code); once it
 * is confirmed the account is a normal email account, with the same player,
 * follows and pass.
 */
export default function CompleteRegistration() {
  const tr = useT();
  const user = session.use((s) => s.user);
  const [email, setEmail] = useState(user?.pendingEmail ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(user?.pendingEmail ?? null);
  const cleanEmail = normalizeEmail(email);

  useEffect(() => {
    void refreshAccount().catch(() => undefined);
  }, []);

  if (!user) {
    return (
      <Screen tabs={false}>
        <BackHeader label={tr("ui.account")} fallback="/account" />
        <Display size={26}>{tr("auth.signInFirst")}</Display>
        <Button label={tr("auth.backToAccount")} onPress={() => router.replace("/account")} style={{ marginTop: 16 }} />
      </Screen>
    );
  }

  if (user.registrationComplete !== false) {
    return (
      <Screen tabs={false}>
        <BackHeader label={tr("ui.account")} fallback="/account" />
        <Eyebrow tone="live">{tr("auth.regComplete")}</Eyebrow>
        <Display size={28} style={{ marginTop: 6 }}>{tr("auth.allSet")}</Display>
        <Body tone="ink2" size={14} style={{ marginTop: 8 }}>
          {user.email ? tr("auth.fromNowOnEmail", { email: user.email }) : tr("auth.fromNowOn")}
        </Body>
        <Button label={tr("common.done")} onPress={() => router.replace("/account")} style={{ marginTop: 18 }} />
      </Screen>
    );
  }

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await completeRegistration(cleanEmail, password);
      setPassword("");
      setConfirm("");
      setSentTo(r.email);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen tabs={false}>
      <>
        <BackHeader label={tr("ui.account")} fallback="/account" />
        <Eyebrow tone="live">{user.name ? tr("auth.welcomeName", { name: user.name }) : tr("auth.welcome")}</Eyebrow>
        <Display size={28} style={{ marginTop: 6 }}>{sentTo ? tr("auth.checkInbox") : tr("auth.completeRegistration")}</Display>
        {sentTo ? (
          <Sent email={sentTo} onChange={() => setSentTo(null)} />
        ) : (
          <>
            <Body tone="ink2" size={14} style={{ marginTop: 8, marginBottom: 14 }}>
              {tr("auth.completeBody")}
            </Body>
            <Card style={{ gap: 14 }}>
              <EmailField value={email} onChangeText={setEmail} returnKeyType="next" />
              <PasswordField isNew value={password} onChangeText={setPassword} returnKeyType="next" />
              <PasswordChecklist password={password} email={cleanEmail} />
              <PasswordField isNew label={tr("auth.confirmPassword")} value={confirm} onChangeText={setConfirm} error={confirm.length > 0 && confirm !== password} />
              {confirm.length > 0 && confirm !== password ? <Body tone="live" size={12.5}>{tr("auth.mismatch")}</Body> : null}
              {err ? <Body tone="live" size={13} accessibilityLiveRegion="polite">{err}</Body> : null}
              <Button
                label={busy ? tr("auth.sending") : tr("auth.sendConfirmation")}
                disabled={!isValidEmail(cleanEmail) || !isStrongPassword(password, cleanEmail) || confirm !== password || busy}
                onPress={() => void submit()}
              />
            </Card>
          </>
        )}
      </>
    </Screen>
  );
}

function Sent({ email, onChange }: { email: string; onChange: () => void }) {
  const tr = useT();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const digits = code.replace(/\D/g, "");
  return (
    <Card style={{ gap: 14, marginTop: 14 }}>
      <Body size={15}>
        {tr("auth.inboxBefore")}
        <Body weight="bold" size={15}>{email}</Body>
        {tr("auth.inboxAfterComplete")}
      </Body>
      <View style={{ gap: 8 }}>
        <Field label={tr("auth.codeLabel")} value={code} onChangeText={setCode} keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode" maxLength={6} placeholder="123456" />
        <Button
          label={busy ? tr("auth.checking") : tr("auth.confirmCode")}
          disabled={digits.length !== 6 || busy}
          onPress={() => {
            setBusy(true);
            setMsg(null);
            verifyEmailCode(email, digits, "complete")
              .then(() => router.replace("/account"), (e: unknown) => setMsg(errorMessage(e)))
              .finally(() => setBusy(false));
          }}
        />
      </View>
      {msg ? <Body tone="live" size={13} accessibilityLiveRegion="polite">{msg}</Body> : null}
      <Button
        kind="ghost"
        label={tr("auth.confirmed")}
        onPress={() => {
          setMsg(null);
          refreshAccount().then(
            () => {
              if (session.get().user?.registrationComplete === false) setMsg(tr("auth.notConfirmedNewest"));
            },
            (e: unknown) => setMsg(errorMessage(e)),
          );
        }}
      />
      <Button kind="ghost" label={tr("auth.changeOrResend")} onPress={onChange} />
    </Card>
  );
}

import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, View } from "react-native";
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

/**
 * "Complete your registration": a player who signed in with their code adds an
 * email and a password. Supabase emails a confirmation link (and code); once it
 * is confirmed the account is a normal email account, with the same player,
 * follows and pass.
 */
export default function CompleteRegistration() {
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
        <BackHeader label="Account" fallback="/account" />
        <Display size={26}>Sign in first</Display>
        <Button label="Back to Account" onPress={() => router.replace("/account")} style={{ marginTop: 16 }} />
      </Screen>
    );
  }

  if (user.registrationComplete !== false) {
    return (
      <Screen tabs={false}>
        <BackHeader label="Account" fallback="/account" />
        <Eyebrow tone="live">Registration complete</Eyebrow>
        <Display size={28} style={{ marginTop: 6 }}>You&apos;re all set</Display>
        <Body tone="ink2" size={14} style={{ marginTop: 8 }}>
          {user.email ? `From now on, sign in with ${user.email} and your password.` : "From now on, sign in with your email and password."}
        </Body>
        <Button label="Done" onPress={() => router.replace("/account")} style={{ marginTop: 18 }} />
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
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <BackHeader label="Account" fallback="/account" />
        <Eyebrow tone="live">{user.name ? `Welcome, ${user.name}` : "Welcome"}</Eyebrow>
        <Display size={28} style={{ marginTop: 6 }}>{sentTo ? "Check your inbox" : "Complete your registration"}</Display>
        {sentTo ? (
          <Sent email={sentTo} onChange={() => setSentTo(null)} />
        ) : (
          <>
            <Body tone="ink2" size={14} style={{ marginTop: 8, marginBottom: 14 }}>
              You&apos;re signed in with your player code. Add your email and a password so you can sign in on any phone and recover your account.
            </Body>
            <Card style={{ gap: 14 }}>
              <EmailField value={email} onChangeText={setEmail} returnKeyType="next" />
              <PasswordField isNew value={password} onChangeText={setPassword} returnKeyType="next" />
              <PasswordChecklist password={password} email={cleanEmail} />
              <PasswordField isNew label="Confirm password" value={confirm} onChangeText={setConfirm} error={confirm.length > 0 && confirm !== password} />
              {confirm.length > 0 && confirm !== password ? <Body tone="live" size={12.5}>The two passwords don&apos;t match.</Body> : null}
              {err ? <Body tone="live" size={13} accessibilityLiveRegion="polite">{err}</Body> : null}
              <Button
                label={busy ? "Sending…" : "Send confirmation email"}
                disabled={!isValidEmail(cleanEmail) || !isStrongPassword(password, cleanEmail) || confirm !== password || busy}
                onPress={() => void submit()}
              />
            </Card>
          </>
        )}
      </KeyboardAvoidingView>
    </Screen>
  );
}

function Sent({ email, onChange }: { email: string; onChange: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const digits = code.replace(/\D/g, "");
  return (
    <Card style={{ gap: 14, marginTop: 14 }}>
      <Body size={15}>
        {"Check your inbox to confirm "}
        <Body weight="bold" size={15}>{email}</Body>
        {". Tap the link in the email — on this phone or any computer — and your registration is complete."}
      </Body>
      <View style={{ gap: 8 }}>
        <Field label="Or enter the 6-digit code from the email" value={code} onChangeText={setCode} keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode" maxLength={6} placeholder="123456" />
        <Button
          label={busy ? "Checking…" : "Confirm with code"}
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
        label="I've confirmed"
        onPress={() => {
          setMsg(null);
          refreshAccount().then(
            () => {
              if (session.get().user?.registrationComplete === false) setMsg("Not confirmed yet. Tap the link in the newest email, then try again.");
            },
            (e: unknown) => setMsg(errorMessage(e)),
          );
        }}
      />
      <Button kind="ghost" label="Change email or resend" onPress={onChange} />
    </Card>
  );
}

import { useEffect, useState } from "react";
import { View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { isStrongPassword, isValidEmail, normalizeEmail } from "@core";
import { errorMessage } from "../../api/client";
import { forgotPassword, needsConfirmation, resendConfirmation, signInWithEmail, signUpWithEmail, verifyEmailCode } from "../../auth/email";
import { EmailField, Field, PasswordChecklist, PasswordField } from "../../auth/fields";
import { Screen } from "../../ui/Screen";
import { BackHeader } from "../../ui/Header";
import { Body, Display, Eyebrow } from "../../ui/Text";
import { Button, Card } from "../../ui/Bits";
import { useT } from "../../i18n";
import type { Key } from "../../i18n/t";

type Mode = "signin" | "signup" | "forgot" | "inbox";

const TITLES: Record<Mode, Key> = {
  signin: "auth.signInEmail",
  signup: "auth.signUpEmail",
  forgot: "auth.forgotTitle",
  inbox: "auth.checkInbox",
};

/** Sign in, sign up, forgot password, and "check your inbox" (with the six-digit code as a fallback). */
export default function EmailAuth() {
  const tr = useT();
  const params = useLocalSearchParams<{ mode?: string; email?: string }>();
  const [mode, setMode] = useState<Mode>(params.mode === "signup" || params.mode === "forgot" || params.mode === "inbox" ? params.mode : "signin");
  const [email, setEmail] = useState(params.email ?? "");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const go = (m: Mode) => {
    setErr(null);
    setNote(null);
    setMode(m);
  };
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      if (needsConfirmation(e)) {
        go("inbox");
        setNote(tr("auth.notConfirmedYet"));
      } else setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const done = () => (router.canGoBack() ? router.back() : router.replace("/account"));
  const cleanEmail = normalizeEmail(email);
  const emailOk = isValidEmail(cleanEmail);

  return (
    <Screen tabs={false}>
      <>
        <BackHeader label={tr("ui.account")} fallback="/account" />
        <Eyebrow tone="live">{`Move Score · ${tr("ui.account")}`}</Eyebrow>
        <Display size={28} style={{ marginTop: 6, marginBottom: 14 }}>{tr(TITLES[mode])}</Display>

        {mode === "signin" && (
          <Card style={{ gap: 14 }}>
            <EmailField value={email} onChangeText={setEmail} returnKeyType="next" />
            <PasswordField value={password} onChangeText={setPassword} onSubmitEditing={() => void run(() => signInWithEmail(cleanEmail, password).then(done))} returnKeyType="go" />
            {err ? <Body tone="live" size={13} accessibilityLiveRegion="polite">{err}</Body> : null}
            <Button label={busy ? tr("auth.signingIn") : tr("auth.signIn")} disabled={!emailOk || !password || busy} onPress={() => void run(() => signInWithEmail(cleanEmail, password).then(done))} />
            <Body tone="blue" weight="semi" size={14} onPress={() => go("forgot")} accessibilityRole="button">{tr("auth.forgotLink")}</Body>
            <Body tone="ink2" size={13}>
              {`${tr("auth.noAccount")} `}
              <Body tone="blue" weight="semi" size={13} onPress={() => go("signup")} accessibilityRole="button">{tr("auth.signUpEmail")}</Body>
            </Body>
          </Card>
        )}

        {mode === "signup" && (
          <Card style={{ gap: 14 }}>
            <Field label={tr("auth.nameOptional")} value={name} onChangeText={setName} autoComplete="name" textContentType="name" placeholder={tr("auth.namePlaceholder")} returnKeyType="next" />
            <EmailField value={email} onChangeText={setEmail} returnKeyType="next" />
            <PasswordField isNew value={password} onChangeText={setPassword} returnKeyType="next" />
            <PasswordChecklist password={password} email={cleanEmail} />
            <PasswordField isNew label={tr("auth.confirmPassword")} value={confirm} onChangeText={setConfirm} error={confirm.length > 0 && confirm !== password} returnKeyType="go" />
            {confirm.length > 0 && confirm !== password ? <Body tone="live" size={12.5}>{tr("auth.mismatch")}</Body> : null}
            {err ? <Body tone="live" size={13} accessibilityLiveRegion="polite">{err}</Body> : null}
            <Button
              label={busy ? tr("auth.creating") : tr("auth.signUp")}
              disabled={!emailOk || !isStrongPassword(password, cleanEmail) || confirm !== password || busy}
              onPress={() =>
                void run(async () => {
                  const r = await signUpWithEmail(cleanEmail, password, name.trim());
                  if (r.status === "signed_in") return done();
                  setPassword("");
                  setConfirm("");
                  go("inbox");
                })
              }
            />
            <Body tone="ink3" size={12}>{tr("auth.signUpNote")}</Body>
            <Body tone="ink2" size={13}>
              {`${tr("auth.haveAccount")} `}
              <Body tone="blue" weight="semi" size={13} onPress={() => go("signin")} accessibilityRole="button">{tr("auth.signIn")}</Body>
            </Body>
          </Card>
        )}

        {mode === "forgot" && (
          <Card style={{ gap: 14 }}>
            <Body tone="ink2" size={13.5}>{tr("auth.forgotBody")}</Body>
            <EmailField value={email} onChangeText={setEmail} returnKeyType="send" />
            {note ? <Body size={13.5} accessibilityLiveRegion="polite">{note}</Body> : null}
            {err ? <Body tone="live" size={13}>{err}</Body> : null}
            <Button label={busy ? tr("auth.sending") : tr("auth.sendReset")} disabled={!emailOk || busy} onPress={() => void run(async () => setNote(await forgotPassword(cleanEmail)))} />
            <Button kind="ghost" label={tr("auth.backToSignIn")} onPress={() => go("signin")} />
          </Card>
        )}

        {mode === "inbox" && <Inbox email={cleanEmail} note={note} onSignIn={() => go("signin")} onDone={done} />}
      </>
    </Screen>
  );
}

/** "Check your inbox to confirm <email>", with Resend (rate-limited here too) and the code from the email. */
function Inbox({ email, note, onSignIn, onDone }: { email: string; note: string | null; onSignIn: () => void; onDone: () => void }) {
  const tr = useT();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(note);
  const [err, setErr] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);
  const digits = code.replace(/\D/g, "");
  return (
    <Card style={{ gap: 14 }}>
      <Body size={15}>
        {tr("auth.inboxBefore")}
        <Body weight="bold" size={15}>{email}</Body>
        {tr("auth.inboxAfterSignIn")}
      </Body>
      {msg ? <Body tone="ink2" size={13} accessibilityLiveRegion="polite">{msg}</Body> : null}
      <Button
        kind="ghost"
        label={wait > 0 ? tr("auth.resendIn", { s: wait }) : tr("auth.resend")}
        disabled={wait > 0 || busy}
        onPress={() => {
          setWait(60);
          setErr(null);
          resendConfirmation(email).then(setMsg, (e: unknown) => setErr(errorMessage(e)));
        }}
      />
      <View style={{ gap: 8, borderTopWidth: 1, borderColor: "transparent", paddingTop: 4 }}>
        <Field label={tr("auth.codeLabel")} value={code} onChangeText={setCode} keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode" maxLength={6} placeholder="123456" />
        {err ? <Body tone="live" size={13}>{err}</Body> : null}
        <Button
          label={busy ? tr("auth.checking") : tr("auth.confirmCode")}
          disabled={digits.length !== 6 || busy}
          onPress={() => {
            setBusy(true);
            setErr(null);
            verifyEmailCode(email, digits, "signup")
              .then(onDone, (e: unknown) => setErr(errorMessage(e)))
              .finally(() => setBusy(false));
          }}
        />
      </View>
      <Button kind="ghost" label={tr("auth.confirmedSignIn")} onPress={onSignIn} />
    </Card>
  );
}

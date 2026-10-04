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

type Mode = "signin" | "signup" | "forgot" | "inbox";

const TITLES: Record<Mode, string> = {
  signin: "Sign in with email",
  signup: "Sign up with email",
  forgot: "Forgot password",
  inbox: "Check your inbox",
};

/** Sign in, sign up, forgot password, and "check your inbox" (with the six-digit code as a fallback). */
export default function EmailAuth() {
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
        setNote("Your email isn't confirmed yet. Open the link we sent you, or send a new one.");
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
        <BackHeader label="Account" fallback="/account" />
        <Eyebrow tone="live">Move Score · Account</Eyebrow>
        <Display size={28} style={{ marginTop: 6, marginBottom: 14 }}>{TITLES[mode]}</Display>

        {mode === "signin" && (
          <Card style={{ gap: 14 }}>
            <EmailField value={email} onChangeText={setEmail} returnKeyType="next" />
            <PasswordField value={password} onChangeText={setPassword} onSubmitEditing={() => void run(() => signInWithEmail(cleanEmail, password).then(done))} returnKeyType="go" />
            {err ? <Body tone="live" size={13} accessibilityLiveRegion="polite">{err}</Body> : null}
            <Button label={busy ? "Signing in…" : "Sign in"} disabled={!emailOk || !password || busy} onPress={() => void run(() => signInWithEmail(cleanEmail, password).then(done))} />
            <Body tone="blue" weight="semi" size={14} onPress={() => go("forgot")} accessibilityRole="button">Forgot password?</Body>
            <Body tone="ink2" size={13}>
              {"No account yet? "}
              <Body tone="blue" weight="semi" size={13} onPress={() => go("signup")} accessibilityRole="button">Sign up with email</Body>
            </Body>
          </Card>
        )}

        {mode === "signup" && (
          <Card style={{ gap: 14 }}>
            <Field label="Your name (optional)" value={name} onChangeText={setName} autoComplete="name" textContentType="name" placeholder="First and last name" returnKeyType="next" />
            <EmailField value={email} onChangeText={setEmail} returnKeyType="next" />
            <PasswordField isNew value={password} onChangeText={setPassword} returnKeyType="next" />
            <PasswordChecklist password={password} email={cleanEmail} />
            <PasswordField isNew label="Confirm password" value={confirm} onChangeText={setConfirm} error={confirm.length > 0 && confirm !== password} returnKeyType="go" />
            {confirm.length > 0 && confirm !== password ? <Body tone="live" size={12.5}>The two passwords don&apos;t match.</Body> : null}
            {err ? <Body tone="live" size={13} accessibilityLiveRegion="polite">{err}</Body> : null}
            <Button
              label={busy ? "Creating your account…" : "Sign up"}
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
            <Body tone="ink3" size={12}>We&apos;ll email you a link to confirm your address. You stay signed in on this phone until you sign out.</Body>
            <Body tone="ink2" size={13}>
              {"Already have an account? "}
              <Body tone="blue" weight="semi" size={13} onPress={() => go("signin")} accessibilityRole="button">Sign in</Body>
            </Body>
          </Card>
        )}

        {mode === "forgot" && (
          <Card style={{ gap: 14 }}>
            <Body tone="ink2" size={13.5}>Enter the email you signed up with. We&apos;ll send a link to choose a new password.</Body>
            <EmailField value={email} onChangeText={setEmail} returnKeyType="send" />
            {note ? <Body size={13.5} accessibilityLiveRegion="polite">{note}</Body> : null}
            {err ? <Body tone="live" size={13}>{err}</Body> : null}
            <Button label={busy ? "Sending…" : "Send reset link"} disabled={!emailOk || busy} onPress={() => void run(async () => setNote(await forgotPassword(cleanEmail)))} />
            <Button kind="ghost" label="Back to sign in" onPress={() => go("signin")} />
          </Card>
        )}

        {mode === "inbox" && <Inbox email={cleanEmail} note={note} onSignIn={() => go("signin")} onDone={done} />}
      </>
    </Screen>
  );
}

/** "Check your inbox to confirm <email>", with Resend (rate-limited here too) and the code from the email. */
function Inbox({ email, note, onSignIn, onDone }: { email: string; note: string | null; onSignIn: () => void; onDone: () => void }) {
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
        {"Check your inbox to confirm "}
        <Body weight="bold" size={15}>{email}</Body>
        {". Tap the link in the email, then come back and sign in."}
      </Body>
      {msg ? <Body tone="ink2" size={13} accessibilityLiveRegion="polite">{msg}</Body> : null}
      <Button
        kind="ghost"
        label={wait > 0 ? `Resend in ${wait}s` : "Resend the email"}
        disabled={wait > 0 || busy}
        onPress={() => {
          setWait(60);
          setErr(null);
          resendConfirmation(email).then(setMsg, (e: unknown) => setErr(errorMessage(e)));
        }}
      />
      <View style={{ gap: 8, borderTopWidth: 1, borderColor: "transparent", paddingTop: 4 }}>
        <Field label="Or enter the 6-digit code from the email" value={code} onChangeText={setCode} keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode" maxLength={6} placeholder="123456" />
        {err ? <Body tone="live" size={13}>{err}</Body> : null}
        <Button
          label={busy ? "Checking…" : "Confirm with code"}
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
      <Button kind="ghost" label="I've confirmed — sign in" onPress={onSignIn} />
    </Card>
  );
}

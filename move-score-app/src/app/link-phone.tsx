import { useState } from "react";
import { Platform, TextInput, View } from "react-native";
import { router, type Href } from "expo-router";
import * as Haptics from "expo-haptics";
import { displayPhone, normalizeOneTimeCode, OTP_LENGTH, toE164, type MPhoneChoice, type MPhoneStart, type MPhoneVerified } from "@core";
import { errorMessage } from "../api/client";
import { session } from "../state/session";
import { useTheme } from "../theme/ThemeProvider";
import { choosePhonePerson, emailPhoneCode, startPhoneCode, verifyPhoneCode } from "../player/me";
import { PlayerAvatar, PlayerIdentity } from "../player/ui";
import { Screen } from "../ui/Screen";
import { BackHeader } from "../ui/Header";
import { Body, Display, Eyebrow } from "../ui/Text";
import { Button, Card, Chip } from "../ui/Bits";

type Step =
  | { kind: "phone" }
  | { kind: "code"; start: MPhoneStart; askEmail: boolean; emailed: string | null }
  | { kind: "choose"; verificationId: string; choices: MPhoneChoice[] }
  | { kind: "done"; result: MPhoneVerified };

/**
 * Link your history with your phone number: a six-digit code on WhatsApp. If
 * WhatsApp does not deliver it, the app asks before the code goes by email (to
 * the address the tournament has for that number). When several players share
 * the phone (a parent's number for two children), the player picks who they are.
 */
export default function LinkPhone() {
  const { t } = useTheme();
  const user = session.use((s) => s.user);
  const [step, setStep] = useState<Step>({ kind: "phone" });
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const finish = (r: MPhoneVerified, verificationId: string) => {
    if (r.choose?.length) return setStep({ kind: "choose", verificationId, choices: r.choose });
    if (Platform.OS !== "web" && r.linked) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setStep({ kind: "done", result: r });
  };

  const input = {
    backgroundColor: t.chip,
    borderColor: err ? t.live : t.line,
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 16,
    color: t.ink,
  } as const;

  if (!user) {
    return (
      <Screen tabs={false}>
        <BackHeader label="Account" fallback="/account" />
        <Display size={28}>Link with your phone</Display>
        <Card style={{ marginTop: 16, gap: 10 }}>
          <Body weight="semi">Sign in first</Body>
          <Body tone="ink2" size={13}>Your history is kept with your account, so it comes with you to a new phone.</Body>
          <Button kind="ghost" label="Back to Account" onPress={() => router.back()} />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen tabs={false}>
      <BackHeader label="Account" fallback="/account" />
      <Eyebrow tone="live">Move Score · Player</Eyebrow>
      <Display size={28} style={{ marginTop: 6 }}>Link with your phone</Display>

      {step.kind === "phone" && (
        <Card style={{ marginTop: 16, gap: 12 }}>
          <Body tone="ink2" size={13.5}>
            Enter the mobile number you gave the tournament. We send a six-digit code on WhatsApp; entering it links every entry recorded with that number to your account.
          </Body>
          <TextInput
            value={phone}
            onChangeText={(v) => {
              setErr(null);
              setPhone(v);
            }}
            keyboardType="phone-pad"
            textContentType="telephoneNumber"
            autoComplete="tel"
            placeholder="0100 123 4567"
            placeholderTextColor={t.ink3}
            accessibilityLabel="Your mobile number"
            style={{ ...input, fontSize: 20 }}
          />
          {phone.trim() && !toE164(phone) ? <Body tone="live" size={12}>Use +country code if the number isn&apos;t Egyptian.</Body> : null}
          {err ? <Body tone="live" size={13}>{err}</Body> : null}
          <Button
            label={busy ? "Sending…" : "Send me a code"}
            disabled={busy || !toE164(phone)}
            onPress={() =>
              void run(async () => {
                const start = await startPhoneCode(phone.trim());
                setCode("");
                setStep({ kind: "code", start, askEmail: !start.sent, emailed: null });
              })
            }
          />
        </Card>
      )}

      {step.kind === "code" && (
        <Card style={{ marginTop: 16, gap: 12 }}>
          <Chip label={displayPhone(step.start.phone)} ball />
          {step.emailed ? (
            <Body tone="ink2" size={13.5}>{step.emailed}</Body>
          ) : step.start.sent ? (
            <Body tone="ink2" size={13.5}>We sent a code on WhatsApp. It works for 10 minutes.</Body>
          ) : null}
          {step.askEmail && !step.emailed ? (
            <View style={{ gap: 10, borderWidth: 1, borderColor: t.ball, borderRadius: 14, padding: 12 }} accessibilityLiveRegion="polite">
              <Body weight="semi">{step.start.sent ? "Didn't get it on WhatsApp?" : "WhatsApp couldn't deliver the code."}</Body>
              <Body tone="ink2" size={13}>Send it by email instead? It goes to the email address the tournament has for this number, if it has one.</Body>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Button kind="ghost" label="Not now" onPress={() => setStep({ ...step, askEmail: false })} style={{ flex: 1 }} />
                <Button
                  label={busy ? "Sending…" : "Send by email"}
                  disabled={busy}
                  onPress={() =>
                    void run(async () => {
                      const r = await emailPhoneCode(step.start.verificationId);
                      setStep({ ...step, askEmail: false, emailed: r.message });
                    })
                  }
                  style={{ flex: 1 }}
                />
              </View>
            </View>
          ) : null}
          <TextInput
            value={code}
            onChangeText={(v) => {
              setErr(null);
              setCode(v.replace(/[^\d٠-٩۰-۹\s]/g, "").slice(0, 12));
            }}
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            autoComplete="one-time-code"
            placeholder="123456"
            placeholderTextColor={t.ink3}
            accessibilityLabel="Six-digit code"
            style={{ ...input, fontSize: 30, letterSpacing: 8, textAlign: "center", fontVariant: ["tabular-nums"] }}
          />
          {err ? <Body tone="live" size={13}>{err}</Body> : null}
          <Button
            label={busy ? "Checking…" : "Link my history"}
            disabled={busy || normalizeOneTimeCode(code)?.length !== OTP_LENGTH}
            onPress={() =>
              void run(async () => {
                const r = await verifyPhoneCode(step.start.verificationId, normalizeOneTimeCode(code)!);
                finish(r, step.start.verificationId);
              })
            }
          />
          {!step.askEmail && !step.emailed ? (
            <Body tone="blue" weight="semi" size={13} onPress={() => setStep({ ...step, askEmail: true })} accessibilityRole="button">
              Didn&apos;t get a code?
            </Body>
          ) : null}
          <Body tone="blue" weight="semi" size={13} onPress={() => setStep({ kind: "phone" })} accessibilityRole="button">
            Use another number
          </Body>
        </Card>
      )}

      {step.kind === "choose" && (
        <View style={{ marginTop: 16, gap: 10 }}>
          <Body tone="ink2" size={13.5}>More than one player has this number. Which one are you?</Body>
          {step.choices.map((c) => (
            <Card key={c.choiceId} style={{ gap: 6 }}>
              <Body weight="semi" size={16}>{c.name}</Body>
              {c.entries.length ? <Body tone="ink2" size={12.5}>{c.entries.join(" · ")}</Body> : null}
              <Button
                label={busy ? "Linking…" : `I'm ${c.name.split(" ")[0]}`}
                disabled={busy}
                onPress={() =>
                  void run(async () => {
                    finish(await choosePhonePerson(step.verificationId, c.choiceId), step.verificationId);
                  })
                }
              />
            </Card>
          ))}
          {err ? <Body tone="live" size={13}>{err}</Body> : null}
        </View>
      )}

      {step.kind === "done" &&
        (step.result.linked ? (
          <View style={{ alignItems: "center", gap: 12, marginTop: 12 }}>
            <PlayerAvatar player={step.result.linked.player} size={96} />
            <Eyebrow tone="live">Linked to your account</Eyebrow>
            <Display size={28} style={{ textAlign: "center" }}>{`You're ${step.result.linked.player.name}`}</Display>
            <PlayerIdentity player={step.result.linked.player} />
            <Body tone="ink2" size={13} style={{ textAlign: "center" }}>
              {step.result.linked.linked > 1 ? `${step.result.linked.linked} entries linked.` : "Your entry is linked."}
            </Body>
            <Button label="See my profile" onPress={() => router.replace("/profile" as Href)} style={{ alignSelf: "stretch" }} />
          </View>
        ) : (
          <Card style={{ marginTop: 16, gap: 10 }}>
            <Body weight="semi">Number confirmed</Body>
            <Body tone="ink2" size={13}>{step.result.message ?? "Nothing to link yet."}</Body>
            <Button kind="ghost" label="Enter a player code" onPress={() => router.replace("/player-code")} />
          </Card>
        ))}
    </Screen>
  );
}

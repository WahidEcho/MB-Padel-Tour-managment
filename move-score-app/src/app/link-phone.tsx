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
import { useT } from "../i18n";

type Step =
  | { kind: "phone" }
  | { kind: "code"; start: MPhoneStart; askEmail: boolean; emailed: string | null }
  | { kind: "choose"; verificationId: string; choices: MPhoneChoice[] }
  | { kind: "done"; result: MPhoneVerified };

/**
 * Link your history with your phone number: a six-digit code on WhatsApp. If
 * WhatsApp does not deliver it, the app asks before the code goes by email: to the
 * account's own email, and only if the tournament recorded that email with the
 * number (an emailed code then links the entries with both). When several players
 * share the phone (a parent's number for two children), the player picks who they are.
 */
export default function LinkPhone() {
  const { t } = useTheme();
  const tr = useT();
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
        <BackHeader label={tr("ui.account")} fallback="/account" />
        <Display size={28}>{tr("player.linkWithPhone")}</Display>
        <Card style={{ marginTop: 16, gap: 10 }}>
          <Body weight="semi">{tr("auth.signInFirst")}</Body>
          <Body tone="ink2" size={13}>{tr("player.historyKept")}</Body>
          <Button kind="ghost" label={tr("auth.backToAccount")} onPress={() => router.back()} />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen tabs={false}>
      <BackHeader label={tr("ui.account")} fallback="/account" />
      <Eyebrow tone="live">{`Move Score · ${tr("player.player")}`}</Eyebrow>
      <Display size={28} style={{ marginTop: 6 }}>{tr("player.linkWithPhone")}</Display>

      {step.kind === "phone" && (
        <Card style={{ marginTop: 16, gap: 12 }}>
          <Body tone="ink2" size={13.5}>
            {tr("player.phoneIntro")}
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
            accessibilityLabel={tr("player.yourMobile")}
            style={{ ...input, fontSize: 20 }}
          />
          {phone.trim() && !toE164(phone) ? <Body tone="live" size={12}>{tr("player.countryCode")}</Body> : null}
          {err ? <Body tone="live" size={13}>{err}</Body> : null}
          <Button
            label={busy ? tr("auth.sending") : tr("player.sendCode")}
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
            <Body tone="ink2" size={13.5}>{tr("player.sentWhatsApp")}</Body>
          ) : null}
          {step.askEmail && !step.emailed ? (
            <View style={{ gap: 10, borderWidth: 1, borderColor: t.ball, borderRadius: 14, padding: 12 }} accessibilityLiveRegion="polite">
              <Body weight="semi">{step.start.sent ? tr("player.didntGetWhatsApp") : tr("player.whatsAppFailed")}</Body>
              <Body tone="ink2" size={13}>
                {user.email
                  ? tr("player.sendToEmail", { email: user.email })
                  : tr("player.sendByEmailQ")}
              </Body>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Button kind="ghost" label={tr("account.notNow")} onPress={() => setStep({ ...step, askEmail: false })} style={{ flex: 1 }} />
                <Button
                  label={busy ? tr("auth.sending") : tr("player.sendByEmail")}
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
            accessibilityLabel={tr("player.sixDigit")}
            style={{ ...input, fontSize: 30, letterSpacing: 8, textAlign: "center", fontVariant: ["tabular-nums"] }}
          />
          {err ? <Body tone="live" size={13}>{err}</Body> : null}
          <Button
            label={busy ? tr("auth.checking") : tr("player.linkHistory")}
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
              {tr("player.didntGetCode")}
            </Body>
          ) : null}
          <Body tone="blue" weight="semi" size={13} onPress={() => setStep({ kind: "phone" })} accessibilityRole="button">
            {tr("player.anotherNumber")}
          </Body>
        </Card>
      )}

      {step.kind === "choose" && (
        <View style={{ marginTop: 16, gap: 10 }}>
          <Body tone="ink2" size={13.5}>{tr("player.whichOne")}</Body>
          {step.choices.map((c) => (
            <Card key={c.choiceId} style={{ gap: 6 }}>
              <Body weight="semi" size={16}>{c.name}</Body>
              {c.entries.length ? <Body tone="ink2" size={12.5}>{c.entries.join(" · ")}</Body> : null}
              <Button
                label={busy ? tr("player.linking") : tr("player.imName", { name: c.name.split(" ")[0] })}
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
            <Eyebrow tone="live">{tr("player.linkedToAccount")}</Eyebrow>
            <Display size={28} style={{ textAlign: "center" }}>{tr("player.youAre", { name: step.result.linked.player.name })}</Display>
            <PlayerIdentity player={step.result.linked.player} />
            <Body tone="ink2" size={13} style={{ textAlign: "center" }}>
              {step.result.linked.linked > 1 ? tr("player.entriesLinked", { count: step.result.linked.linked }) : tr("player.entryLinked")}
            </Body>
            <Button label={tr("player.seeProfile")} onPress={() => router.replace("/profile" as Href)} style={{ alignSelf: "stretch" }} />
          </View>
        ) : (
          <Card style={{ marginTop: 16, gap: 10 }}>
            <Body weight="semi">{step.result.confirmed === "email" ? tr("auth.emailConfirmed") : tr("player.numberConfirmed")}</Body>
            <Body tone="ink2" size={13}>{step.result.message ?? tr("player.nothingToLink")}</Body>
            <Button kind="ghost" label={tr("player.enterPlayerCode")} onPress={() => router.replace("/player-code")} />
          </Card>
        ))}
    </Screen>
  );
}

import { useState } from "react";
import { Platform, TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import { ACCESS_CODE_LENGTH, displayPhone, isValidAccessCode, normalizeAccessCode, type MMyPlayer } from "@core";
import { ApiError } from "../api/client";
import { session } from "../state/session";
import { useTheme } from "../theme/ThemeProvider";
import { claimPlayerCode } from "../player/me";
import { signInWithPlayerCode } from "../auth/email";
import { useConfig } from "../api/queries";
import { MyMatchRow, PlayerAvatar, PlayerIdentity } from "../player/ui";
import { Screen } from "../ui/Screen";
import { BackHeader } from "../ui/Header";
import { Body, Display, Eyebrow } from "../ui/Text";
import { Button, Card, Chip, SectionHeader } from "../ui/Bits";
import { useT } from "../i18n";

/** ABCD-2345 as it is typed: the dash appears after the fourth character. */
const shown = (raw: string) => {
  const c = normalizeAccessCode(raw).slice(0, ACCESS_CODE_LENGTH);
  return c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
};

/**
 * Enter the player code the tournament sent. Signed in: links the player to the
 * account ("You're <name>"). Signed out: the code itself signs the player in (no
 * sign-up needed, the tournament already has their name and phone), then asks
 * them to complete their registration by adding an email.
 */
export default function PlayerCode() {
  const { t } = useTheme();
  const tr = useT();
  const params = useLocalSearchParams<{ code?: string }>();
  const user = session.use((s) => s.user);
  const cfg = useConfig();
  // Older servers (no player-code sign-in) do not report it: sign in first, as before.
  const codeSignIn = cfg.data?.signIn?.playerCode === true;
  const [signedInWithCode, setSignedInWithCode] = useState(false);
  const [code, setCode] = useState(() => (params.code ? shown(params.code) : ""));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ player: MMyPlayer; linked: number } | null>(null);
  const bare = normalizeAccessCode(code);
  const ready = isValidAccessCode(bare);

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const viaCode = !user;
      const r = viaCode ? await signInWithPlayerCode(bare) : await claimPlayerCode(bare);
      setSignedInWithCode(viaCode);
      if (Platform.OS !== "web") void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setDone(r);
    } catch (e) {
      setErr(e instanceof ApiError && e.status ? e.message : tr("player.noSignal"));
    } finally {
      setBusy(false);
    }
  };

  if (done && signedInWithCode) {
    const p = done.player;
    return (
      <Screen tabs={false}>
        <BackHeader label={tr("ui.account")} fallback="/account" />
        <View style={{ alignItems: "center", gap: 12, marginTop: 8 }}>
          <PlayerAvatar player={p} size={96} />
          <Eyebrow tone="live">{tr("player.signedInWithCode")}</Eyebrow>
          <Display size={30} style={{ textAlign: "center" }}>{tr("auth.welcomeName", { name: p.name })}</Display>
          <PlayerIdentity player={p} />
        </View>
        <Card style={{ marginTop: 18, gap: 10, borderColor: t.ball, borderWidth: 1 }}>
          <Body weight="semi" size={16}>{tr("auth.completeRegistration")}</Body>
          <Body tone="ink2" size={13}>{tr("player.addEmailBody")}</Body>
          <Button label={tr("player.addMyEmail")} onPress={() => router.replace("/auth/complete")} />
          <Button kind="ghost" label={tr("player.later")} onPress={() => router.replace("/account")} />
        </Card>
      </Screen>
    );
  }

  if (done) {
    const p = done.player;
    const tz = p.entries[0]?.timezone ?? "Africa/Cairo";
    return (
      <Screen tabs={false}>
        <BackHeader label={tr("ui.account")} />
        <View style={{ alignItems: "center", gap: 12, marginTop: 8 }}>
          <PlayerAvatar player={p} size={96} />
          <Eyebrow tone="live">{tr("player.linkedToAccount")}</Eyebrow>
          <Display size={30} style={{ textAlign: "center" }}>{tr("player.youAre", { name: p.name })}</Display>
          <PlayerIdentity player={p} />
          <Body tone="ink2" size={13.5}>{p.phone ? displayPhone(p.phone) : tr("player.addPhoneInAccount")}</Body>
          {done.linked > 1 && <Body tone="ink2" size={12.5} style={{ textAlign: "center" }}>{tr("player.alsoLinked", { count: done.linked - 1 })}</Body>}
        </View>
        {p.matches.length > 0 && <SectionHeader title={tr("player.yourMatches")} />}
        <View style={{ gap: 8 }}>
          {p.matches.slice(0, 5).map((m) => (
            <MyMatchRow key={m.id} m={m} timezone={p.entries.find((e) => e.tournamentSlug === m.tournamentSlug)?.timezone ?? tz} />
          ))}
        </View>
        <Button label={tr("common.done")} onPress={() => router.back()} style={{ marginTop: 18 }} />
        <Body tone="ink3" size={12} style={{ marginTop: 8, textAlign: "center" }}>{tr("player.addPhotoHint")}</Body>
      </Screen>
    );
  }

  return (
    <Screen tabs={false}>
      <BackHeader label={tr("ui.account")} />
      <Eyebrow tone="live">{`Move Score · ${tr("player.player")}`}</Eyebrow>
      <Display size={30} style={{ marginTop: 6 }}>{tr("player.playerCode")}</Display>
      <Body tone="ink2" size={14} style={{ marginTop: 8 }}>
        {tr("player.codeIntro")}
      </Body>
      {!user && !codeSignIn ? (
        <Card style={{ marginTop: 16, gap: 10 }}>
          <Body weight="semi">{tr("auth.signInFirst")}</Body>
          <Body tone="ink2" size={13}>{tr("player.keptWithAccount")}</Body>
          <Button kind="ghost" label={tr("auth.backToAccount")} onPress={() => router.back()} />
        </Card>
      ) : (
        <Card style={{ marginTop: 16, gap: 12 }}>
          <Chip label={tr("player.playerCode")} ball />
          <TextInput
            value={code}
            onChangeText={(v) => {
              setErr(null);
              setCode(shown(v));
            }}
            autoCapitalize="characters"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
            keyboardType={Platform.OS === "android" ? "visible-password" : "default"}
            placeholder="ABCD-2345"
            placeholderTextColor={t.ink3}
            accessibilityLabel={tr("player.playerCode")}
            accessibilityHint={tr("player.codeHint")}
            onSubmitEditing={() => void submit()}
            returnKeyType="go"
            style={{
              backgroundColor: t.chip,
              borderColor: err ? t.live : t.line,
              borderWidth: 1,
              borderRadius: 16,
              paddingHorizontal: 16,
              paddingVertical: 18,
              color: t.ink,
              fontSize: 32,
              letterSpacing: 6,
              textAlign: "center",
              fontVariant: ["tabular-nums"],
            }}
          />
          <Body tone="ink3" size={12}>{tr("player.pasteHint")}</Body>
          {!user ? <Body tone="ink2" size={12.5}>{tr("player.noAccountNeeded")}</Body> : null}
          {err ? <Body tone="live" size={13}>{err}</Body> : null}
          {err && /already registered|Sign in with your email/i.test(err) ? (
            <Button kind="ghost" label={tr("auth.signInEmail")} onPress={() => router.replace({ pathname: "/auth/email", params: { mode: "signin" } })} />
          ) : null}
          <Button label={busy ? tr("auth.checking") : user ? tr("player.linkProfile") : tr("player.signInWithCode")} disabled={!ready || busy} onPress={() => void submit()} />
        </Card>
      )}
    </Screen>
  );
}

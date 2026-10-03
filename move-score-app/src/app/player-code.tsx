import { useState } from "react";
import { Platform, TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import { ACCESS_CODE_LENGTH, displayPhone, isValidAccessCode, normalizeAccessCode, type MMyPlayer } from "@core";
import { ApiError } from "../api/client";
import { session } from "../state/session";
import { useTheme } from "../theme/ThemeProvider";
import { claimPlayerCode } from "../player/me";
import { MyMatchRow, PlayerAvatar, PlayerIdentity } from "../player/ui";
import { Screen } from "../ui/Screen";
import { BackHeader } from "../ui/Header";
import { Body, Display, Eyebrow } from "../ui/Text";
import { Button, Card, Chip, SectionHeader } from "../ui/Bits";

/** ABCD-2345 as it is typed: the dash appears after the fourth character. */
const shown = (raw: string) => {
  const c = normalizeAccessCode(raw).slice(0, ACCESS_CODE_LENGTH);
  return c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
};

/** Enter the player code the tournament sent; on success, "You're <name>". */
export default function PlayerCode() {
  const { t } = useTheme();
  const params = useLocalSearchParams<{ code?: string }>();
  const user = session.use((s) => s.user);
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
      const r = await claimPlayerCode(bare);
      if (Platform.OS !== "web") void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setDone(r);
    } catch (e) {
      setErr(e instanceof ApiError && e.status ? e.message : "No connection. Check the signal and try again.");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    const p = done.player;
    const tz = p.entries[0]?.timezone ?? "Africa/Cairo";
    return (
      <Screen tabs={false}>
        <BackHeader label="Account" />
        <View style={{ alignItems: "center", gap: 12, marginTop: 8 }}>
          <PlayerAvatar player={p} size={96} />
          <Eyebrow tone="live">Linked to your account</Eyebrow>
          <Display size={30} style={{ textAlign: "center" }}>{`You're ${p.name}`}</Display>
          <PlayerIdentity player={p} />
          <Body tone="ink2" size={13.5}>{p.phone ? displayPhone(p.phone) : "Add your phone number in Account."}</Body>
          {done.linked > 1 && <Body tone="ink2" size={12.5} style={{ textAlign: "center" }}>{`Also linked in ${done.linked - 1} other tournament${done.linked === 2 ? "" : "s"}.`}</Body>}
        </View>
        {p.matches.length > 0 && <SectionHeader title="Your matches" />}
        <View style={{ gap: 8 }}>
          {p.matches.slice(0, 5).map((m) => (
            <MyMatchRow key={m.id} m={m} timezone={p.entries.find((e) => e.tournamentSlug === m.tournamentSlug)?.timezone ?? tz} />
          ))}
        </View>
        <Button label="Done" onPress={() => router.back()} style={{ marginTop: 18 }} />
        <Body tone="ink3" size={12} style={{ marginTop: 8, textAlign: "center" }}>Add your photo and phone in Account, under My player profile.</Body>
      </Screen>
    );
  }

  return (
    <Screen tabs={false}>
      <BackHeader label="Account" />
      <Eyebrow tone="live">Move Score · Player</Eyebrow>
      <Display size={30} style={{ marginTop: 6 }}>Player code</Display>
      <Body tone="ink2" size={14} style={{ marginTop: 8 }}>
        The tournament sends each player a private code on WhatsApp or by email. Enter it to see your matches and add your photo and phone.
      </Body>
      {!user ? (
        <Card style={{ marginTop: 16, gap: 10 }}>
          <Body weight="semi">Sign in first</Body>
          <Body tone="ink2" size={13}>Your player profile is kept with your account, so it comes with you to a new phone.</Body>
          <Button kind="ghost" label="Back to Account" onPress={() => router.back()} />
        </Card>
      ) : (
        <Card style={{ marginTop: 16, gap: 12 }}>
          <Chip label="Player code" ball />
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
            accessibilityLabel="Player code"
            accessibilityHint="Eight letters and numbers. You can paste the whole message."
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
          <Body tone="ink3" size={12}>Long-press to paste: the whole WhatsApp message works, the code is picked out of it.</Body>
          {err ? <Body tone="live" size={13}>{err}</Body> : null}
          <Button label={busy ? "Checking…" : "Link my player profile"} disabled={!ready || busy} onPress={() => void submit()} />
        </Card>
      )}
    </Screen>
  );
}

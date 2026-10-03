/**
 * Account's player part: the "Player code" row (next to the referee sign-in),
 * the one-time "Are you playing?" prompt right after signing in, and once a code
 * is linked, "My player profile": photo, name, nation, phone and matches.
 */
import { useEffect, useRef, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { router } from "expo-router";
import { displayPhone, toE164 } from "@core";
import { ApiError } from "../api/client";
import { useConfig } from "../api/queries";
import { session } from "../state/session";
import { useTheme } from "../theme/ThemeProvider";
import { Body, Display, Eyebrow } from "../ui/Text";
import { Button, Card, Chip, SectionHeader } from "../ui/Bits";
import { canUseCamera, changePlayerPhoto, fetchMyPlayer, markPlayerPromptAsked, playerPromptAsked, savePlayerPhone, unlinkPlayer, useMyPlayer } from "./me";
import { MyMatchRow, PlayerAvatar, PlayerIdentity } from "./ui";

const failed = (e: unknown) =>
  e instanceof ApiError ? (e.status ? e.message : "No connection. Try again.") : e instanceof Error && e.message ? e.message : "Something went wrong. Try again.";

export function PlayerSection() {
  const user = session.use((s) => s.user);
  const cfg = useConfig();
  const codeSignIn = cfg.data?.signIn?.playerCode === true;
  const q = useMyPlayer();
  const [prompt, setPrompt] = useState(false);
  const prevUser = useRef(user?.id);

  // Signed in just now, on this screen: ask once whether they are playing.
  useEffect(() => {
    const was = prevUser.current;
    prevUser.current = user?.id;
    if (!user || was || playerPromptAsked(user.id)) return;
    void fetchMyPlayer()
      .then((p) => setPrompt(!p))
      .catch(() => undefined);
  }, [user]);

  const openCode = () => {
    if (user) markPlayerPromptAsked(user.id);
    setPrompt(false);
    router.push("/player-code");
  };
  const player = user ? q.data : null;

  return (
    <>
      <SectionHeader title={player ? "My player profile" : "Player"} />
      {player ? (
        <Profile />
      ) : prompt && user ? (
        <PromptCard
          onEnter={openCode}
          onSkip={() => {
            markPlayerPromptAsked(user.id);
            setPrompt(false);
          }}
        />
      ) : (
        <Card onPress={openCode} style={{ gap: 4 }} accessibilityLabel="Player code">
          <Body weight="semi">Player code</Body>
          <Body tone="ink2" size={12.5}>
            {user
              ? "Playing? Enter the code the tournament sent you to see your matches and add your photo."
              : codeSignIn
                ? "Playing? Enter the code the tournament sent you. It signs you in, no account needed."
                : "Playing? Sign in above, then enter the code the tournament sent you."}
          </Body>
        </Card>
      )}
    </>
  );
}

function PromptCard({ onEnter, onSkip }: { onEnter: () => void; onSkip: () => void }) {
  const { t } = useTheme();
  return (
    <Card style={{ gap: 10, borderColor: t.ball, borderWidth: 1 }}>
      <Chip label="New" ball />
      <Body weight="semi" size={16}>Are you playing? Enter your player code</Body>
      <Body tone="ink2" size={13}>The tournament sends each player a private code on WhatsApp or by email. It links your matches, photo and phone to this account.</Body>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button kind="ghost" label="Not now" onPress={onSkip} style={{ flex: 1 }} />
        <Button label="Enter code" onPress={onEnter} style={{ flex: 1 }} />
      </View>
    </Card>
  );
}

function Profile() {
  const { t } = useTheme();
  const q = useMyPlayer();
  const p = q.data!;
  const [choosing, setChoosing] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  // What is being typed; null shows the saved number.
  const [draft, setDraft] = useState<string | null>(null);
  const phone = draft ?? displayPhone(p.phone);
  const [phoneMsg, setPhoneMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [savingPhone, setSavingPhone] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const changed = phone.trim() !== displayPhone(p.phone);
  const valid = !phone.trim() || Boolean(toE164(phone));
  const tzOf = (slug: string) => p.entries.find((e) => e.tournamentSlug === slug)?.timezone ?? "Africa/Cairo";

  const pickPhoto = async (source: "camera" | "library") => {
    setChoosing(false);
    setErr(null);
    setPhotoBusy(true);
    try {
      await changePlayerPhoto(source);
    } catch (e) {
      setErr(failed(e));
    } finally {
      setPhotoBusy(false);
    }
  };
  const savePhone = async () => {
    setSavingPhone(true);
    setPhoneMsg(null);
    try {
      const next = await savePlayerPhone(phone.trim());
      setDraft(null);
      setPhoneMsg({ ok: true, text: next.phone ? "Saved." : "Removed." });
    } catch (e) {
      setPhoneMsg({ ok: false, text: failed(e) });
    } finally {
      setSavingPhone(false);
    }
  };

  return (
    <Card style={{ gap: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
        <Pressable
          onPress={() => setChoosing((c) => !c)}
          accessibilityRole="button"
          accessibilityLabel={p.photoUrl ? "Change your photo" : "Add your photo"}
          disabled={photoBusy}
          style={{ opacity: photoBusy ? 0.5 : 1 }}
        >
          <PlayerAvatar player={p} size={76} />
          <View style={{ position: "absolute", right: -2, bottom: -2, backgroundColor: t.ball, borderRadius: 12, paddingHorizontal: 7, paddingVertical: 2 }}>
            <Body size={11} weight="bold" tone="onBall">{photoBusy ? "…" : p.photoUrl ? "Edit" : "Add"}</Body>
          </View>
        </Pressable>
        <View style={{ flex: 1, gap: 6 }}>
          <Display size={22}>{p.name}</Display>
          <PlayerIdentity player={p} />
        </View>
      </View>
      {choosing && (
        <View style={{ flexDirection: "row", gap: 8 }}>
          {canUseCamera && <Button kind="ghost" label="Take photo" onPress={() => void pickPhoto("camera")} style={{ flex: 1 }} />}
          <Button kind="ghost" label="Choose photo" onPress={() => void pickPhoto("library")} style={{ flex: 1 }} />
        </View>
      )}
      {err ? <Body tone="live" size={13}>{err}</Body> : null}

      <View style={{ gap: 6, borderTopWidth: 1, borderColor: t.line, paddingTop: 12 }}>
        <Eyebrow size={10}>Phone (only the organisers see it)</Eyebrow>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <TextInput
            value={phone}
            onChangeText={(v) => {
              setDraft(v);
              setPhoneMsg(null);
            }}
            keyboardType="phone-pad"
            textContentType="telephoneNumber"
            autoComplete="tel"
            placeholder="0100 123 4567"
            placeholderTextColor={t.ink3}
            accessibilityLabel="Your phone number"
            style={{ flex: 1, backgroundColor: t.chip, borderColor: valid ? t.line : t.live, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, color: t.ink, fontSize: 16 }}
          />
          {changed && <Button label={savingPhone ? "Saving…" : "Save"} disabled={!valid || savingPhone} onPress={() => void savePhone()} />}
        </View>
        {!valid ? (
          <Body tone="live" size={12}>That doesn't look like a phone number. Use +country code if it isn't Egyptian.</Body>
        ) : phoneMsg ? (
          <Body tone={phoneMsg.ok ? "ink2" : "live"} size={12}>{phoneMsg.text}</Body>
        ) : null}
      </View>

      <View style={{ gap: 8, borderTopWidth: 1, borderColor: t.line, paddingTop: 12 }}>
        <Eyebrow size={10}>My matches</Eyebrow>
        {p.matches.length === 0 ? (
          <Body tone="ink2" size={13}>No matches scheduled yet. They appear here as soon as the draw is made.</Body>
        ) : (
          p.matches.map((m) => <MyMatchRow key={m.id} m={m} timezone={tzOf(m.tournamentSlug)} />)
        )}
        {p.entries.length > 0 && (
          <Body tone="ink3" size={12}>{p.entries.map((e) => e.tournamentName).join(" · ")}</Body>
        )}
      </View>

      {confirmUnlink ? (
        <View style={{ gap: 8 }}>
          <Body size={13}>{`Unlink ${p.name} from this account? A photo you added is removed. You can link again with the same code.`}</Body>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button kind="ghost" label="Keep" onPress={() => setConfirmUnlink(false)} style={{ flex: 1 }} />
            <Button
              kind="danger"
              label="Unlink"
              onPress={() =>
                void unlinkPlayer()
                  .then(() => setConfirmUnlink(false))
                  .catch((e) => setErr(failed(e)))
              }
              style={{ flex: 1 }}
            />
          </View>
        </View>
      ) : (
        <Body tone="blue" weight="semi" size={13} onPress={() => setConfirmUnlink(true)}>Not you? Unlink</Body>
      )}
    </Card>
  );
}

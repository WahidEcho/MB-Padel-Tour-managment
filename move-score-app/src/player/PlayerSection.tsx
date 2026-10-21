/**
 * Account's player part: the "Player code" row (next to the referee sign-in),
 * the one-time "Are you playing?" prompt right after signing in, "Is this you?"
 * suggestions (entries recorded with the account's email, organisers' offers),
 * the phone-number way in, and once linked, "My player profile": photo, name,
 * nation, phone and matches, with My profile (history) one tap away.
 */
import { useEffect, useRef, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { router, type Href } from "expo-router";
import { displayPhone, toE164 } from "@core";
import { ApiError } from "../api/client";
import { useConfig } from "../api/queries";
import { session } from "../state/session";
import { useTheme } from "../theme/ThemeProvider";
import { Body, Display, Eyebrow } from "../ui/Text";
import { Button, Card, Chip, SectionHeader } from "../ui/Bits";
import { answerSuggestion, declinedSuggestions, suggestionKey, canUseCamera, changePlayerPhoto, fetchMyPlayer, markPlayerPromptAsked, playerPromptAsked, savePlayerPhone, unlinkPlayer, useLinkSuggestions, useMyPlayer } from "./me";
import type { MLinkSuggestion } from "@core";
import { MyMatchRow, PlayerAvatar, PlayerIdentity } from "./ui";
import { useT } from "../i18n";
import { tr as trNow } from "../i18n/t";

const failed = (e: unknown) =>
  e instanceof ApiError ? (e.status ? e.message : trNow("auth.noConnection")) : e instanceof Error && e.message ? e.message : trNow("auth.wrongTryAgain");

export function PlayerSection() {
  const tr = useT();
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
  // Registered accounts only: a code-only account has no confirmed email to match.
  const sugg = useLinkSuggestions(Boolean(user) && user?.registrationComplete !== false);
  const declined = declinedSuggestions();
  const suggestions = (sugg.data ?? []).filter((x) => !declined.has(suggestionKey(x)));

  return (
    <>
      <SectionHeader title={player ? tr("player.myPlayerProfile") : tr("player.player")} />
      {suggestions.map((s) => (
        <SuggestionCard key={s.id} s={s} />
      ))}
      {player ? (
        <>
          <Profile />
          <Card onPress={() => router.push("/profile" as Href)} style={{ gap: 4, marginTop: 8 }} accessibilityLabel={tr("player.myProfile")}>
            <Body weight="semi">{tr("player.myProfile")}</Body>
            <Body tone="ink2" size={12.5}>{tr("player.myProfileHint")}</Body>
          </Card>
        </>
      ) : prompt && user ? (
        <PromptCard
          onEnter={openCode}
          onSkip={() => {
            markPlayerPromptAsked(user.id);
            setPrompt(false);
          }}
        />
      ) : (
        <Card onPress={openCode} style={{ gap: 4 }} accessibilityLabel={tr("player.playerCode")}>
          <Body weight="semi">{tr("player.playerCode")}</Body>
          <Body tone="ink2" size={12.5}>
            {user
              ? tr("player.codeHintUser")
              : codeSignIn
                ? tr("player.codeHintSignIn")
                : tr("player.codeHintFirst")}
          </Body>
        </Card>
      )}
      {user && !player ? (
        <Card onPress={() => router.push("/link-phone" as Href)} style={{ gap: 4, marginTop: 8 }} accessibilityLabel={tr("player.linkPhoneA11y")}>
          <Body weight="semi">{tr("player.noCode")}</Body>
          <Body tone="ink2" size={12.5}>{tr("player.noCodeHint")}</Body>
        </Card>
      ) : null}
    </>
  );
}

/** "Is this you?": confirm or decline a suggestion; nothing links before "That's me". */
function SuggestionCard({ s }: { s: MLinkSuggestion }) {
  const { t } = useTheme();
  const tr = useT();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const answer = (accept: boolean) => {
    setBusy(true);
    setErr(null);
    void answerSuggestion(s, accept)
      .catch((e) => setErr(failed(e)))
      .finally(() => setBusy(false));
  };
  return (
    <Card style={{ gap: 8, borderColor: t.ball, borderWidth: 1, marginBottom: 8 }}>
      <Chip label={tr("player.isThisYou")} ball />
      <Body weight="semi" size={16}>{s.name}</Body>
      <Body tone="ink2" size={13}>
        {s.kind === "offer"
          ? tr("player.offerSays", { org: s.organization ?? tr("player.anOrganiser"), name: s.name })
          : tr("player.emailMatch")}
        {s.entries.length ? ` ${s.entries.join(" · ")}` : ""}
      </Body>
      {err ? <Body tone="live" size={13}>{err}</Body> : null}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button kind="ghost" label={tr("player.notMe")} disabled={busy} onPress={() => answer(false)} style={{ flex: 1 }} />
        <Button label={busy ? tr("player.linking") : tr("player.thatsMe")} disabled={busy} onPress={() => answer(true)} style={{ flex: 1 }} />
      </View>
    </Card>
  );
}

function PromptCard({ onEnter, onSkip }: { onEnter: () => void; onSkip: () => void }) {
  const { t } = useTheme();
  const tr = useT();
  return (
    <Card style={{ gap: 10, borderColor: t.ball, borderWidth: 1 }}>
      <Chip label={tr("player.new")} ball />
      <Body weight="semi" size={16}>{tr("player.promptTitle")}</Body>
      <Body tone="ink2" size={13}>{tr("player.promptBody")}</Body>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button kind="ghost" label={tr("account.notNow")} onPress={onSkip} style={{ flex: 1 }} />
        <Button label={tr("player.enterCode")} onPress={onEnter} style={{ flex: 1 }} />
      </View>
    </Card>
  );
}

function Profile() {
  const { t } = useTheme();
  const tr = useT();
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
      setPhoneMsg({ ok: true, text: next.phone ? tr("player.saved") : tr("player.removed") });
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
          accessibilityLabel={p.photoUrl ? tr("auth.changePhoto") : tr("player.addYourPhoto")}
          disabled={photoBusy}
          style={{ opacity: photoBusy ? 0.5 : 1 }}
        >
          <PlayerAvatar player={p} size={76} />
          <View style={{ position: "absolute", right: -2, bottom: -2, backgroundColor: t.ball, borderRadius: 12, paddingHorizontal: 7, paddingVertical: 2 }}>
            <Body size={11} weight="bold" tone="onBall">{photoBusy ? "…" : p.photoUrl ? tr("common.edit") : tr("player.add")}</Body>
          </View>
        </Pressable>
        <View style={{ flex: 1, gap: 6 }}>
          <Display size={22}>{p.name}</Display>
          <PlayerIdentity player={p} />
        </View>
      </View>
      {choosing && (
        <View style={{ flexDirection: "row", gap: 8 }}>
          {canUseCamera && <Button kind="ghost" label={tr("player.takePhoto")} onPress={() => void pickPhoto("camera")} style={{ flex: 1 }} />}
          <Button kind="ghost" label={tr("player.choosePhoto")} onPress={() => void pickPhoto("library")} style={{ flex: 1 }} />
        </View>
      )}
      {err ? <Body tone="live" size={13}>{err}</Body> : null}

      <View style={{ gap: 6, borderTopWidth: 1, borderColor: t.line, paddingTop: 12 }}>
        <Eyebrow size={10}>{tr("player.phoneLabel")}</Eyebrow>
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
            accessibilityLabel={tr("player.yourPhone")}
            style={{ flex: 1, backgroundColor: t.chip, borderColor: valid ? t.line : t.live, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, color: t.ink, fontSize: 16 }}
          />
          {changed && <Button label={savingPhone ? tr("common.saving") : tr("common.save")} disabled={!valid || savingPhone} onPress={() => void savePhone()} />}
        </View>
        {!valid ? (
          <Body tone="live" size={12}>{tr("player.badPhone")}</Body>
        ) : phoneMsg ? (
          <Body tone={phoneMsg.ok ? "ink2" : "live"} size={12}>{phoneMsg.text}</Body>
        ) : null}
      </View>

      <View style={{ gap: 8, borderTopWidth: 1, borderColor: t.line, paddingTop: 12 }}>
        <Eyebrow size={10}>{tr("player.myMatches")}</Eyebrow>
        {p.matches.length === 0 ? (
          <Body tone="ink2" size={13}>{tr("player.noMatches")}</Body>
        ) : (
          p.matches.map((m) => <MyMatchRow key={m.id} m={m} timezone={tzOf(m.tournamentSlug)} />)
        )}
        {p.entries.length > 0 && (
          <Body tone="ink3" size={12}>{p.entries.map((e) => e.tournamentName).join(" · ")}</Body>
        )}
      </View>

      {confirmUnlink ? (
        <View style={{ gap: 8 }}>
          <Body size={13}>{tr("player.unlinkConfirm", { name: p.name })}</Body>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button kind="ghost" label={tr("player.keep")} onPress={() => setConfirmUnlink(false)} style={{ flex: 1 }} />
            <Button
              kind="danger"
              label={tr("player.unlink")}
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
        <Body tone="blue" weight="semi" size={13} onPress={() => setConfirmUnlink(true)}>{tr("player.notYouUnlink")}</Body>
      )}
    </Card>
  );
}

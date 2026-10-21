/**
 * Account → "Edit name and photo": a sheet with the account's avatar (tap it to
 * choose a photo from the library), a name field, Save and "Remove photo". What
 * the server answers is saved on the phone straight away (auth/profile.ts).
 */
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, TextInput, View } from "react-native";
import { Image } from "expo-image";
import { checkDisplayName, DISPLAY_NAME_MAX } from "@core";
import { ApiError } from "../api/client";
import { session } from "../state/session";
import { useTheme } from "../theme/ThemeProvider";
import { Sheet } from "../referee/Sheet";
import { Body } from "../ui/Text";
import { Button } from "../ui/Bits";
import { canUseCamera } from "../player/me";
import { changeAccountPhoto, removeAccountPhoto, saveAccountName } from "./profile";
import { displayNameError } from "./fields";
import { useT } from "../i18n";
import { tr as trNow } from "../i18n/t";

const failed = (e: unknown) =>
  e instanceof ApiError ? (e.status ? e.message : trNow("auth.noConnection")) : e instanceof Error && e.message ? e.message : trNow("auth.wrongTryAgain");

export function EditProfileSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTheme();
  const tr = useT();
  const user = session.use((s) => s.user);
  const [name, setName] = useState(user?.name ?? "");
  const [busy, setBusy] = useState<null | "name" | "photo" | "remove">(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName(session.get().user?.name ?? "");
      setErr(null);
    }
  }, [open]);
  if (!user) return null;
  const check = checkDisplayName(name);
  const changed = check.ok ? check.name !== (user.name ?? "") : name.trim() !== (user.name ?? "");
  const initial = (user.name || user.email || "?").trim().charAt(0).toUpperCase();

  const run = async (which: "name" | "photo" | "remove", fn: () => Promise<unknown>) => {
    setErr(null);
    setBusy(which);
    try {
      await fn();
      return true;
    } catch (e) {
      const m = failed(e);
      if (!/cancel/i.test(m)) setErr(m);
      return false;
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    if (!check.ok) return setErr(displayNameError(check.error));
    if (await run("name", () => saveAccountName(check.name))) onClose();
  };
  const pick = (source: "camera" | "library") => void run("photo", () => changeAccountPhoto(source));

  return (
    <Sheet open={open} onClose={onClose} title={tr("auth.editNamePhoto")}>
      <View style={{ alignItems: "center", gap: 12, paddingVertical: 4 }}>
        <Pressable
          onPress={() => pick("library")}
          disabled={busy !== null}
          accessibilityRole="button"
          accessibilityLabel={user.avatarUrl ? tr("auth.changePhoto") : tr("auth.addPhoto")}
          accessibilityHint={tr("auth.opensLibrary")}
          style={({ pressed }) => ({ opacity: pressed ? 0.75 : 1 })}
        >
          {user.avatarUrl ? (
            <Image source={{ uri: user.avatarUrl }} style={{ width: 96, height: 96, borderRadius: 48, backgroundColor: t.chip }} contentFit="cover" accessibilityIgnoresInvertColors />
          ) : (
            <View style={{ width: 96, height: 96, borderRadius: 48, backgroundColor: t.chip, borderWidth: 1, borderColor: t.line, alignItems: "center", justifyContent: "center" }}>
              <Body weight="bold" size={34}>{initial}</Body>
            </View>
          )}
          {busy === "photo" && (
            <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderRadius: 48, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center" }}>
              <ActivityIndicator color="#FFFFFF" />
            </View>
          )}
        </Pressable>
        <Body tone="blue" weight="semi" size={14} onPress={busy ? undefined : () => pick("library")} accessibilityRole="button">
          {user.avatarUrl ? tr("auth.anotherPhoto") : tr("auth.addPhoto")}
        </Body>
        {canUseCamera && (
          <Body tone="ink2" weight="semi" size={13} onPress={busy ? undefined : () => pick("camera")} accessibilityRole="button">
            {tr("auth.takePhoto")}
          </Body>
        )}
      </View>

      <View style={{ gap: 6 }}>
        <Body weight="semi" size={14}>{tr("auth.yourName")}</Body>
        <TextInput
          value={name}
          onChangeText={(v) => {
            setName(v);
            setErr(null);
          }}
          maxLength={DISPLAY_NAME_MAX + 10}
          autoCapitalize="words"
          autoComplete="name"
          textContentType="name"
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={() => void save()}
          placeholder={tr("auth.namePlaceholder")}
          placeholderTextColor={t.ink3}
          accessibilityLabel={tr("auth.yourName")}
          style={{ backgroundColor: t.chip, borderColor: err ? t.live : t.line, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 12, color: t.ink, fontSize: 16 }}
        />
        <Body tone="ink3" size={12}>{tr("auth.nameNote")}</Body>
      </View>

      {err ? (
        <Body tone="live" size={13} accessibilityLiveRegion="polite">
          {err}
        </Body>
      ) : null}

      <Button label={busy === "name" ? tr("common.saving") : tr("common.save")} disabled={busy !== null || !changed || !check.ok} onPress={() => void save()} />
      {user.avatarUrl ? (
        <Button kind="ghost" label={busy === "remove" ? tr("auth.removing") : tr("auth.removePhoto")} disabled={busy !== null} onPress={() => void run("remove", removeAccountPhoto)} />
      ) : null}
      <Button kind="ghost" label={tr("common.done")} onPress={onClose} disabled={busy === "name"} />
    </Sheet>
  );
}

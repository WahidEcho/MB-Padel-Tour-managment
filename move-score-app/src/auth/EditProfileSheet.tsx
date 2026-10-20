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

const failed = (e: unknown) =>
  e instanceof ApiError ? (e.status ? e.message : "No connection. Try again.") : e instanceof Error && e.message ? e.message : "Something went wrong. Try again.";

export function EditProfileSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTheme();
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
    if (!check.ok) return setErr(check.error);
    if (await run("name", () => saveAccountName(check.name))) onClose();
  };
  const pick = (source: "camera" | "library") => void run("photo", () => changeAccountPhoto(source));

  return (
    <Sheet open={open} onClose={onClose} title="Edit name and photo">
      <View style={{ alignItems: "center", gap: 12, paddingVertical: 4 }}>
        <Pressable
          onPress={() => pick("library")}
          disabled={busy !== null}
          accessibilityRole="button"
          accessibilityLabel={user.avatarUrl ? "Change your photo" : "Add a photo"}
          accessibilityHint="Opens your photo library"
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
          {user.avatarUrl ? "Choose another photo" : "Add a photo"}
        </Body>
        {canUseCamera && (
          <Body tone="ink2" weight="semi" size={13} onPress={busy ? undefined : () => pick("camera")} accessibilityRole="button">
            Take a photo
          </Body>
        )}
      </View>

      <View style={{ gap: 6 }}>
        <Body weight="semi" size={14}>Your name</Body>
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
          placeholder="First and last name"
          placeholderTextColor={t.ink3}
          accessibilityLabel="Your name"
          style={{ backgroundColor: t.chip, borderColor: err ? t.live : t.line, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 12, color: t.ink, fontSize: 16 }}
        />
        <Body tone="ink3" size={12}>Shown on your account. Organisers still use the name on your entry.</Body>
      </View>

      {err ? (
        <Body tone="live" size={13} accessibilityLiveRegion="polite">
          {err}
        </Body>
      ) : null}

      <Button label={busy === "name" ? "Saving…" : "Save"} disabled={busy !== null || !changed || !check.ok} onPress={() => void save()} />
      {user.avatarUrl ? (
        <Button kind="ghost" label={busy === "remove" ? "Removing…" : "Remove photo"} disabled={busy !== null} onPress={() => void run("remove", removeAccountPhoto)} />
      ) : null}
      <Button kind="ghost" label="Done" onPress={onClose} disabled={busy === "name"} />
    </Sheet>
  );
}

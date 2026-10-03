import { useEffect, useState } from "react";
import { Linking, Platform, Switch, View } from "react-native";
import { router } from "expo-router";
import * as AppleAuthentication from "expo-apple-authentication";
import { alertsNotice, type MAlertPrefs } from "@core";
import { useConfig } from "../api/queries";
import { themePref, useTheme, type ModePref } from "../theme/ThemeProvider";
import { session } from "../state/session";
import { alerts, refreshAlerts, turnAlertsOff, turnAlertsOn } from "../push/register";
import { alertPrefs, changeAlertPref, refreshPrefs } from "../push/prefs";
import { appleAvailable, deleteAccount, signInWithApple, signInWithGoogle, signOut } from "../auth/signIn";
import { Screen } from "../ui/Screen";
import { BackHeader } from "../ui/Header";
import { Segments } from "../ui/Segments";
import { Body, Display, Eyebrow } from "../ui/Text";
import { Button, Card, SectionHeader } from "../ui/Bits";
import { appVersion, config } from "../config";

// Where the legal pages live when the server's config has not loaded yet.
const SITE = "https://mb-tournament.vercel.app/movescore";

// Google sign-in needs its client id on this platform; without one the button
// could only fail, so it is not shown (Sign in with Apple stays on iPhone).
const googleReady =
  Platform.OS === "ios" ? !!config.googleIosClientId : Platform.OS === "android" ? !!config.googleWebClientId : false;

const PREF_LABELS: [keyof MAlertPrefs, string, string][] = [
  ["scheduled", "Set or moved", "A court or time is set, changed or delayed"],
  ["starting", "Starting soon", "15 minutes before play"],
  ["live", "On court now", "The moment a match starts"],
  ["finished", "Results", "When a match you follow finishes"],
  ["tie", "Tie results", "When a nation you support wins or loses a tie"],
  ["major", "Big announcements", "Start of play, finals, delays. Rare."],
];

export default function Account() {
  const { t } = useTheme();
  const cfg = useConfig();
  const pref = themePref.use((s) => s);
  const user = session.use((s) => s.user);
  const staff = session.use((s) => s.staff);
  const alertState = alerts.use((s) => s);
  const prefs = alertPrefs.use((s) => s.prefs);
  const notice = alertsNotice(alertState);
  const [apple, setApple] = useState(false);
  const [ageOk, setAgeOk] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    void refreshAlerts();
    void refreshPrefs();
    void appleAvailable().then(setApple);
  }, []);
  const run = async (fn: () => Promise<void>) => {
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      const m = e instanceof Error ? e.message : "Something went wrong";
      if (!/cancel/i.test(m)) setMsg(m);
    }
  };
  return (
    <Screen tabs={false}>
      <BackHeader label="Back" />
      <Display size={26}>Account</Display>

      <SectionHeader title="Alerts" />
      <Card style={{ gap: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Body weight="semi">Alerts on this phone</Body>
            <Body tone="ink2" size={12.5}>For the players, nations and matches you follow.</Body>
          </View>
          <Switch
            value={alertState.want}
            onValueChange={(on) => void (on ? turnAlertsOn() : turnAlertsOff())}
            trackColor={{ true: t.ball, false: t.chip }}
            thumbColor={Platform.OS === "android" ? t.ink : undefined}
            accessibilityLabel="Alerts on this phone"
          />
        </View>
        {notice && (
          <View accessibilityLiveRegion="polite" style={{ gap: 8 }}>
            <Body tone={alertState.reason ? "live" : "ink2"} size={13}>{notice.text}</Body>
            {notice.action === "settings" && <Button kind="ghost" label="Open Settings" onPress={() => void Linking.openSettings()} />}
            {notice.action === "retry" && <Button kind="ghost" label="Try again" onPress={() => void turnAlertsOn()} />}
          </View>
        )}
        {alertState.want &&
          PREF_LABELS.map(([k, label, hint]) => (
            <View key={k} style={{ flexDirection: "row", alignItems: "center", gap: 12, borderTopWidth: 1, borderColor: t.line, paddingTop: 12 }}>
              <View style={{ flex: 1 }}>
                <Body size={14}>{label}</Body>
                <Body tone="ink3" size={12}>{hint}</Body>
              </View>
              <Switch value={prefs[k]} onValueChange={(on) => changeAlertPref(k, on)} trackColor={{ true: t.ball, false: t.chip }} accessibilityLabel={label} />
            </View>
          ))}
      </Card>

      <SectionHeader title="Look" />
      <Segments<ModePref>
        value={pref.mode}
        onChange={(mode) => themePref.set((s) => ({ ...s, mode }))}
        options={[
          { key: "system", label: "Phone" },
          { key: "dark", label: "Dark" },
          { key: "light", label: "Light" },
        ]}
      />
      <Card style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Body weight="semi">Reduce motion</Body>
          <Body tone="ink2" size={12.5}>Calmer animations. Also follows the phone's own setting.</Body>
        </View>
        <Switch value={pref.calm} onValueChange={(calm) => themePref.set((s) => ({ ...s, calm }))} trackColor={{ true: t.ball, false: t.chip }} accessibilityLabel="Reduce motion" />
      </Card>

      {cfg.data?.flags.accounts !== false && (user || apple || googleReady) && (
        <>
          <SectionHeader title="Sign in" />
          {user ? (
            <Card style={{ gap: 10 }}>
              <Body weight="semi">{user.name ? `Signed in as ${user.name}` : "Signed in"}</Body>
              <Body tone="ink2" size={12.5}>Your follows and pass are saved to your account and come with you to a new phone.</Body>
              <Button kind="ghost" label="Sign out" onPress={() => void run(signOut)} />
              {confirmDelete ? (
                <View style={{ gap: 8 }}>
                  <Body size={13}>This deletes your account, your follows and your pass. It cannot be undone.</Body>
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <Button kind="ghost" label="Keep it" onPress={() => setConfirmDelete(false)} style={{ flex: 1 }} />
                    <Button kind="danger" label="Delete" onPress={() => void run(deleteAccount)} style={{ flex: 1 }} />
                  </View>
                </View>
              ) : (
                <Button kind="ghost" label="Delete account" onPress={() => setConfirmDelete(true)} />
              )}
            </Card>
          ) : (
            <Card style={{ gap: 12 }}>
              <Body tone="ink2" size={13}>Optional. Everything works without an account; signing in keeps your follows and pass when you change phones.</Body>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                <Switch value={ageOk} onValueChange={setAgeOk} trackColor={{ true: t.ball, false: t.chip }} accessibilityLabel="I am 16 or older" />
                <Body size={14} style={{ flex: 1 }}>I am 16 or older</Body>
              </View>
              {apple && ageOk && (
                <AppleAuthentication.AppleAuthenticationButton
                  buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
                  buttonStyle={t.scheme === "dark" ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
                  cornerRadius={14}
                  style={{ height: 48 }}
                  onPress={() => void run(signInWithApple)}
                />
              )}
              {ageOk && googleReady && <Button kind="ghost" label="Sign in with Google" onPress={() => void run(signInWithGoogle)} />}
              {!ageOk && <Eyebrow tone="ink3">Under 16? Use Move Score without an account.</Eyebrow>}
            </Card>
          )}
        </>
      )}
      {msg ? <Body tone="live" size={13} style={{ marginTop: 10 }}>{msg}</Body> : null}

      <SectionHeader title="Staff" />
      <Card onPress={() => router.push("/referee")} style={{ gap: 4 }}>
        <Body weight="semi">{staff ? `Referee mode · ${staff.role}` : "Referee sign-in"}</Body>
        <Body tone="ink2" size={12.5}>For officials scoring matches at the event.</Body>
      </Card>

      <SectionHeader title="About" />
      <Card style={{ gap: 10 }}>
        <Body tone="blue" weight="semi" onPress={() => void Linking.openURL(cfg.data?.privacyUrl ?? `${SITE}/privacy`)}>Privacy policy</Body>
        <Body tone="blue" weight="semi" onPress={() => void Linking.openURL(`${SITE}/terms`)}>Terms of use</Body>
        <Body tone="blue" weight="semi" onPress={() => void Linking.openURL(cfg.data?.supportUrl ?? `${SITE}/support`)}>Help and support</Body>
        <Body tone="ink3" size={12}>{`Move Score ${appVersion} · ${config.appEnv}`}</Body>
      </Card>
    </Screen>
  );
}

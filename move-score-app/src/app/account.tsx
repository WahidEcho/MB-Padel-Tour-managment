import { useEffect, useState } from "react";
import { Linking, Platform, Pressable, Switch, View } from "react-native";
import { router } from "expo-router";
import * as AppleAuthentication from "expo-apple-authentication";
import { Image } from "expo-image";
import { alertsNotice, APP_PAGE_URL, type MAlertPrefs } from "@core";
import { useConfig } from "../api/queries";
import { themePref, useTheme, type ModePref } from "../theme/ThemeProvider";
import { session } from "../state/session";
import { alerts, refreshAlerts, turnAlertsOff, turnAlertsOn } from "../push/register";
import { alertPrefs, changeAlertPref, refreshPrefs } from "../push/prefs";
import { appleAvailable, deleteAccount, signInWithApple, signInWithGoogle, signOut } from "../auth/signIn";
import { GoogleButton } from "../auth/GoogleButton";
import { Screen } from "../ui/Screen";
import { BackHeader } from "../ui/Header";
import { Segments } from "../ui/Segments";
import { Body, Display } from "../ui/Text";
import { Button, Card, SectionHeader } from "../ui/Bits";
import { appVersion, config } from "../config";
import { PlayerSection } from "../player/PlayerSection";
import { RegistrationBanner } from "../auth/RegistrationBanner";
import { EditProfileSheet } from "../auth/EditProfileSheet";
import { refreshAccount } from "../auth/email";
import { openLeagues } from "../nav/links";
import { chooseLang, langPref, phoneLang, useT, type LangPref } from "../i18n";
import type { Key } from "../i18n/t";

const LANG_NAMES = { en: "English", es: "Español", fr: "Français" } as const;

// Where the legal pages live when the server's config has not loaded yet.
const SITE = APP_PAGE_URL;

const PROVIDER_LABEL: Record<string, Key | string> = { google: "Google", apple: "Apple", email: "account.providerEmail", player_code: "account.providerCode" };

const PREF_LABELS: [keyof MAlertPrefs, Key, Key][] = [
  ["scheduled", "account.prefScheduled", "account.prefScheduledHint"],
  ["starting", "account.prefStarting", "account.prefStartingHint"],
  ["live", "account.prefLive", "account.prefLiveHint"],
  ["court", "account.prefCourt", "account.prefCourtHint"],
  ["finished", "account.prefFinished", "account.prefFinishedHint"],
  ["tie", "account.prefTie", "account.prefTieHint"],
  ["major", "account.prefMajor", "account.prefMajorHint"],
];

const NOTICE_KEYS: Record<string, Key> = {
  settings: "account.noticeSettings",
  register: "account.noticeRegister",
  unsupported: "account.noticeUnsupported",
  waiting: "account.noticeWaiting",
};

const ROLE_KEYS: Record<string, Key> = {
  referee: "account.roleReferee",
  master_referee: "account.roleMaster",
  manager: "account.roleManager",
  admin: "account.roleAdmin",
};

// App Review (guideline 5.1.1(v)) needs account deletion reachable in the app; it sits in the
// profile menu under Sign out.
const SHOW_DELETE_ACCOUNT = true;

export default function Account() {
  const { t } = useTheme();
  const cfg = useConfig();
  const tr = useT();
  const pref = themePref.use((s) => s);
  const lang = langPref.use((s) => s);
  const user = session.use((s) => s.user);
  const staff = session.use((s) => s.staff);
  const coach = session.use((s) => s.coach);
  const alertState = alerts.use((s) => s);
  const prefs = alertPrefs.use((s) => s.prefs);
  const notice = alertsNotice(alertState);
  const [apple, setApple] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [googleBusy, setGoogleBusy] = useState(false);
  // Google signs in through Supabase in the in-app browser sheet; the server says
  // when the provider is switched on there (Sign in with Apple stays on iPhone).
  const googleReady = cfg.data?.signIn?.google === true;
  const emailReady = cfg.data?.signIn?.email === true;
  const codeReady = cfg.data?.signIn?.playerCode === true && cfg.data?.flags.player_claim !== false;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  // A player-code account with no email yet cannot be signed back into except with the code
  // (as a new account): say so before signing out.
  const unregistered = user?.registrationComplete === false;
  useEffect(() => {
    void refreshAlerts();
    void refreshPrefs();
    void appleAvailable().then(setApple);
    // The name and photo may have been changed on another phone.
    if (session.get().user) void refreshAccount().catch(() => undefined);
  }, []);
  const providerLabel = (p: string | null | undefined) => {
    const k = PROVIDER_LABEL[p ?? ""];
    return k ? (k.includes(".") ? tr(k as Key) : k) : null;
  };
  const run = async (fn: () => Promise<void>) => {
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      const m = e instanceof Error ? e.message : tr("common.somethingWrong");
      if (!/cancel/i.test(m)) setMsg(m);
    }
  };
  return (
    <Screen tabs={false}>
      <BackHeader label={tr("common.back")} />
      <Display size={26}>{tr("ui.account")}</Display>

      <SectionHeader title={tr("account.alerts")} />
      <Card style={{ gap: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Body weight="semi">{tr("account.alertsHere")}</Body>
            <Body tone="ink2" size={12.5}>{tr("account.alertsHereHint")}</Body>
          </View>
          <Switch
            value={alertState.want}
            onValueChange={(on) => void (on ? turnAlertsOn() : turnAlertsOff())}
            trackColor={{ true: t.ball, false: t.chip }}
            thumbColor={Platform.OS === "android" ? t.ink : undefined}
            accessibilityLabel={tr("account.alertsHere")}
          />
        </View>
        {notice && (
          <View accessibilityLiveRegion="polite" style={{ gap: 8 }}>
            <Body tone={alertState.reason ? "live" : "ink2"} size={13}>{tr(NOTICE_KEYS[alertState.reason ?? "waiting"] ?? "account.noticeWaiting")}</Body>
            {notice.action === "settings" && <Button kind="ghost" label={tr("account.openSettings")} onPress={() => void Linking.openSettings()} />}
            {notice.action === "retry" && <Button kind="ghost" label={tr("common.retry")} onPress={() => void turnAlertsOn()} />}
          </View>
        )}
        {alertState.want &&
          PREF_LABELS.map(([k, label, hint]) => (
            <View key={k} style={{ flexDirection: "row", alignItems: "center", gap: 12, borderTopWidth: 1, borderColor: t.line, paddingTop: 12 }}>
              <View style={{ flex: 1 }}>
                <Body size={14}>{tr(label)}</Body>
                <Body tone="ink3" size={12}>{tr(hint)}</Body>
              </View>
              <Switch value={prefs[k]} onValueChange={(on) => changeAlertPref(k, on)} trackColor={{ true: t.ball, false: t.chip }} accessibilityLabel={tr(label)} />
            </View>
          ))}
      </Card>

      <SectionHeader title={tr("account.leagues")} />
      <Card onPress={openLeagues} accessibilityLabel={tr("account.leaguesA11y")} style={{ gap: 2 }}>
        <Body weight="semi">{tr("account.myLeagues")}</Body>
        <Body tone="ink2" size={12.5}>{tr("account.myLeaguesHint")}</Body>
      </Card>

      <SectionHeader title={tr("account.look")} />
      <Segments<ModePref>
        value={pref.mode}
        onChange={(mode) => themePref.set((s) => ({ ...s, mode }))}
        options={[
          { key: "system", label: tr("account.lookPhone") },
          { key: "dark", label: tr("account.lookDark") },
          { key: "light", label: tr("account.lookLight") },
        ]}
      />
      <Card style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Body weight="semi">{tr("account.reduceMotion")}</Body>
          <Body tone="ink2" size={12.5}>{tr("account.reduceMotionHint")}</Body>
        </View>
        <Switch value={pref.calm} onValueChange={(calm) => themePref.set((s) => ({ ...s, calm }))} trackColor={{ true: t.ball, false: t.chip }} accessibilityLabel={tr("account.reduceMotion")} />
      </Card>

      <SectionHeader title={tr("account.language")} />
      <Segments<LangPref>
        value={lang}
        onChange={chooseLang}
        options={[
          { key: "auto", label: tr("account.langAuto") },
          // Each language in its own words, so anyone can find theirs.
          { key: "en", label: "English" },
          { key: "es", label: "Español" },
          { key: "fr", label: "Français" },
        ]}
      />
      <Body tone="ink3" size={12} style={{ marginTop: -6 }}>
        {lang === "auto" ? tr("account.langAutoHint", { lang: LANG_NAMES[phoneLang()] }) : tr("account.langFixedHint")}
      </Body>

      {cfg.data?.flags.accounts !== false && (user || apple || googleReady || emailReady || codeReady) && (
        <>
          <SectionHeader title={tr("auth.signIn")} />
          {user ? (
            <Card style={{ gap: 12 }}>
              <Pressable
                onPress={() => {
                  setMenuOpen((o) => !o);
                  setConfirmSignOut(false);
                  setConfirmDelete(false);
                }}
                accessibilityRole="button"
                accessibilityState={{ expanded: menuOpen }}
                accessibilityHint={tr("account.menuHint")}
                style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 12, padding: 10, margin: -4, borderRadius: 16, borderWidth: 1, borderColor: t.line, backgroundColor: t.chip, opacity: pressed ? 0.75 : 1 })}
              >
                {user.avatarUrl ? (
                  <Image source={{ uri: user.avatarUrl }} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: t.chip }} contentFit="cover" accessibilityLabel={tr("account.profilePicture")} />
                ) : (
                  <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: t.chip, alignItems: "center", justifyContent: "center" }}>
                    <Body weight="bold" size={17}>{(user.name || user.email || "?").trim().charAt(0).toUpperCase()}</Body>
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Body weight="semi" numberOfLines={1}>{user.name ? tr("account.signedInAs", { name: user.name }) : tr("account.signedIn")}</Body>
                  {user.email || user.provider ? (
                    <Body tone="ink2" size={12.5} numberOfLines={1}>
                      {[user.email, providerLabel(user.provider)].filter(Boolean).join(" · ")}
                    </Body>
                  ) : null}
                </View>
                <Body weight="bold" size={18} tone="ink3" style={{ transform: [{ rotate: menuOpen ? "-90deg" : "90deg" }] }}>
                  ›
                </Body>
              </Pressable>
              {!user.name && (
                <Card onPress={() => setEditOpen(true)} accessibilityLabel={tr("account.addName")} style={{ gap: 4, borderColor: t.ball, borderWidth: 1 }}>
                  <Body weight="semi">{tr("account.addName")}</Body>
                  <Body tone="ink2" size={12.5}>{tr("account.addNameHint")}</Body>
                </Card>
              )}
              {menuOpen && (
                <View style={{ gap: 8 }}>
                  <Button kind="ghost" label={tr("auth.editNamePhoto")} onPress={() => setEditOpen(true)} />
                  <Button kind="ghost" label={tr("stories.manageBlocked")} onPress={() => router.push("/blocked-stories")} />
                  {confirmSignOut ? (
                    <View style={{ gap: 8 }}>
                      <Body size={13}>
                        {tr("account.signOutWarning")}
                      </Body>
                      <View style={{ flexDirection: "row", gap: 8 }}>
                        <Button kind="ghost" label={tr("account.stay")} onPress={() => setConfirmSignOut(false)} style={{ flex: 1 }} />
                        <Button kind="danger" label={tr("account.signOut")} onPress={() => void run(signOut).then(() => setConfirmSignOut(false))} style={{ flex: 1 }} />
                      </View>
                    </View>
                  ) : (
                    <Button kind="ghost" label={tr("account.signOut")} onPress={() => (unregistered ? setConfirmSignOut(true) : void run(signOut))} />
                  )}
                  {SHOW_DELETE_ACCOUNT &&
                    (confirmDelete ? (
                      <View style={{ gap: 8 }}>
                        <Body size={13}>{tr("account.deleteWarning")}</Body>
                        <View style={{ flexDirection: "row", gap: 8 }}>
                          <Button kind="ghost" label={tr("account.keepIt")} onPress={() => setConfirmDelete(false)} style={{ flex: 1 }} />
                          <Button kind="danger" label={tr("common.delete")} onPress={() => void run(deleteAccount)} style={{ flex: 1 }} />
                        </View>
                      </View>
                    ) : (
                      <Button kind="ghost" label={tr("account.deleteAccount")} onPress={() => setConfirmDelete(true)} />
                    ))}
                </View>
              )}
              <RegistrationBanner />
              <EditProfileSheet open={editOpen} onClose={() => setEditOpen(false)} />
              <Body tone="ink2" size={12.5}>{tr("account.savedNote")}</Body>
            </Card>
          ) : (
            <Card style={{ gap: 12 }}>
              <Body tone="ink2" size={13}>{tr("account.optionalNote")}</Body>
              {apple && (
                <AppleAuthentication.AppleAuthenticationButton
                  buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
                  buttonStyle={t.scheme === "dark" ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
                  cornerRadius={14}
                  style={{ height: 48 }}
                  onPress={() => void run(signInWithApple)}
                />
              )}
              {googleReady && (
                <GoogleButton
                  busy={googleBusy}
                  onPress={() => {
                    setGoogleBusy(true);
                    void run(signInWithGoogle).finally(() => setGoogleBusy(false));
                  }}
                />
              )}
              {emailReady && (
                <>
                  <Button kind="ghost" label={tr("auth.signInEmail")} onPress={() => router.push({ pathname: "/auth/email", params: { mode: "signin" } })} />
                  <Button kind="ghost" label={tr("auth.signUpEmail")} onPress={() => router.push({ pathname: "/auth/email", params: { mode: "signup" } })} />
                </>
              )}
              {codeReady && (
                <Body tone="blue" weight="semi" size={14} style={{ textAlign: "center", paddingVertical: 4 }} onPress={() => router.push("/player-code")} accessibilityRole="button">
                  {tr("account.haveCode")}
                </Body>
              )}
            </Card>
          )}
        </>
      )}
      {msg ? <Body tone="live" size={13} style={{ marginTop: 10 }}>{msg}</Body> : null}

      {cfg.data?.flags.player_claim !== false && <PlayerSection />}

      <SectionHeader title={tr("account.staff")} />
      <View style={{ gap: 12 }}>
        <Card onPress={() => router.push("/referee")} style={{ gap: 6 }}>
          <Body weight="semi">{staff ? tr("account.refereeMode", { role: ROLE_KEYS[staff.role] ? tr(ROLE_KEYS[staff.role]!) : staff.role }) : tr("account.refereeSignIn")}</Body>
          <Body tone="ink2" size={12.5}>{tr("account.refereeHint")}</Body>
        </Card>
        <Card onPress={() => router.push(coach ? "/coach/team" : "/coach")} style={{ gap: 4 }} accessibilityLabel={coach ? tr("account.myTeamA11y", { team: coach.team.name }) : tr("account.coachSignIn")}>
          <Body weight="semi">{coach ? tr("account.myTeam", { team: coach.team.name }) : tr("account.coachSignIn")}</Body>
          <Body tone="ink2" size={12.5}>{tr("account.coachHint")}</Body>
        </Card>

        <Card onPress={() => void Linking.openURL(`${config.apiBaseUrl}/organizations/apply?via=app`)} accessibilityLabel={tr("account.applyA11y")} style={{ gap: 4 }}>
          <Body weight="semi">{tr("account.applyTitle")}</Body>
          <Body tone="ink2" size={12.5}>{tr("account.applyHint")}</Body>
        </Card>
      </View>

      <SectionHeader title={tr("account.about")} />
      <Card style={{ gap: 10 }}>
        <Body tone="blue" weight="semi" onPress={() => void Linking.openURL(cfg.data?.privacyUrl ?? `${SITE}/privacy`)}>{tr("account.privacy")}</Body>
        <Body tone="blue" weight="semi" onPress={() => void Linking.openURL(`${SITE}/terms`)}>{tr("account.terms")}</Body>
        <Body tone="blue" weight="semi" onPress={() => void Linking.openURL(cfg.data?.supportUrl ?? `${SITE}/support`)}>{tr("account.support")}</Body>
        <Body tone="ink3" size={12}>{`Move Score ${appVersion} · ${config.appEnv}`}</Body>
      </Card>
    </Screen>
  );
}

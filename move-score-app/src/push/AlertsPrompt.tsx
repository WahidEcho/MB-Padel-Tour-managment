/**
 * Asks for notifications: on first open (a welcome card, then the system question),
 * and again every few days while they are blocked in the phone's Settings or switched
 * off in the app. When to ask is the pure rule alertsPromptFor (src/lib/mobile/alertsPrompt.ts);
 * re-checked at launch and on every return to the app. Never over a referee's scoring screen.
 */
import { useCallback, useEffect, useState } from "react";
import { AppState, Linking, Modal, Platform, View } from "react-native";
import { usePathname } from "expo-router";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import { alertsPermission, alertsPromptFor, type AlertsPrompt as Kind } from "@core";
import { useTheme } from "../theme/ThemeProvider";
import { Body, Display } from "../ui/Text";
import { Button } from "../ui/Bits";
import { getJson, setJson } from "../state/kv";
import { alerts, refreshAlerts, turnAlertsOn } from "./register";
import { ASKED } from "./ask";
import { useT } from "../i18n";
import type { Key } from "../i18n/en";

const NUDGED = "ms.alertsNudgedAt";
/** Screens a card must never cover: a referee scoring a point, a coach mid-line-up. */
const QUIET = [/^\/referee\/score\//, /^\/coach\//];

/** The card's words for each case, in the app's language. */
const COPY: Record<Kind, { title: Key; body: Key; yes: Key }> = {
  first: { title: "account.alertsFirstTitle", body: "account.alertsFirstBody", yes: "account.alertsFirstYes" },
  settings: { title: "account.alertsSettingsTitle", body: "account.alertsSettingsBody", yes: "account.alertsSettingsYes" },
  enable: { title: "account.alertsEnableTitle", body: "account.alertsEnableBody", yes: "account.alertsEnableYes" },
};

export function AlertsPrompt() {
  const { t } = useTheme();
  const tr = useT();
  const path = usePathname();
  const [kind, setKind] = useState<Kind | null>(null);

  const check = useCallback(async () => {
    if (Platform.OS === "web") return;
    try {
      await refreshAlerts();
      const permission = alertsPermission(await Notifications.getPermissionsAsync());
      setKind(
        alertsPromptFor({
          supported: Device.isDevice,
          permission,
          wantAlerts: alerts.get().want,
          asked: getJson<boolean>(ASKED, false),
          lastNudgeAt: getJson<number | null>(NUDGED, null),
          nowMs: Date.now(),
        }),
      );
    } catch {
      // Not knowing is no reason to interrupt anyone.
    }
  }, []);

  useEffect(() => {
    void check();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void check();
    });
    return () => sub.remove();
  }, [check]);

  const done = () => {
    // The card counts as shown either way: the first one never repeats, reminders wait NUDGE_DAYS.
    setJson(ASKED, true);
    setJson(NUDGED, Date.now());
    setKind(null);
  };
  const yes = () => {
    const k = kind;
    done();
    if (k === "settings") void Linking.openSettings().catch(() => {});
    else void turnAlertsOn();
  };

  if (!kind || QUIET.some((r) => r.test(path))) return null;
  const c = COPY[kind];
  return (
    <Modal transparent animationType="fade" visible onRequestClose={done}>
      <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.55)" }}>
        <View
          accessibilityViewIsModal
          style={{ backgroundColor: t.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 40, gap: 14 }}
        >
          <Display size={26}>{tr(c.title)}</Display>
          <Body tone="ink2">{tr(c.body)}</Body>
          {Platform.OS === "ios" ? <Body tone="ink3" size={13}>{tr("account.alertsUrgent")}</Body> : null}
          <Button label={tr(c.yes)} onPress={yes} />
          <Button kind="ghost" label={tr("account.notNow")} onPress={done} />
        </View>
      </View>
    </Modal>
  );
}

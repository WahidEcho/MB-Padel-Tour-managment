/**
 * Asks for alert permission at the moment it makes sense: right after the first
 * follow or star, with a line saying what alerts are for, then the system
 * prompt. Asked at most once per install; the Account switch stays the way to
 * change one's mind later.
 */
import { Alert, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { getJson, setJson } from "../state/kv";
import { registerDevice } from "./register";

const ASKED = "ms.alertsAsked";

export async function askForAlertsAfterFollow(): Promise<void> {
  if (Platform.OS === "web") return;
  if (getJson<boolean>(ASKED, false)) return;
  let status: Notifications.PermissionStatus;
  try {
    status = (await Notifications.getPermissionsAsync()).status;
  } catch {
    return;
  }
  // Already allowed or refused (the system will not prompt again): nothing to ask.
  setJson(ASKED, true);
  if (status !== Notifications.PermissionStatus.UNDETERMINED) return;
  Alert.alert(
    "Get alerts for what you follow?",
    "Move Score can tell you when matches you follow are scheduled, about to start and finished. You can change this any time in Account.",
    [
      { text: "Not now", style: "cancel" },
      { text: "Turn on alerts", onPress: () => void registerDevice(true) },
    ],
    { cancelable: true },
  );
}

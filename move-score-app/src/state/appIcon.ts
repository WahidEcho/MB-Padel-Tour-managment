/**
 * The app icon, chosen on the server: flag `icon_mark` on = the Move Score mark ("Mark",
 * bundled by the expo-alternate-app-icons plugin in app.config.ts), off = the default icon.
 * iPhone only: iOS shows its own "You have changed the icon" notice once per change. A new
 * design still needs a new build (icons are part of the binary); the server only picks one.
 * Builds without the native module (1.0.3 and older) do nothing.
 */
import { useEffect } from "react";
import { Platform } from "react-native";
import { useConfig } from "../api/queries";

type Icons = { supportsAlternateIcons: boolean; getAppIconName(): string | null; setAlternateAppIcon(name: string | null): Promise<string | null> };

function icons(): Icons | null {
  if (Platform.OS !== "ios") return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require("expo-alternate-app-icons") as Icons;
    return m.supportsAlternateIcons ? m : null;
  } catch {
    return null;
  }
}

export function AppIconSync() {
  const cfg = useConfig();
  const want = cfg.data ? (cfg.data.flags.icon_mark === true ? "Mark" : null) : undefined;
  useEffect(() => {
    if (want === undefined) return;
    const m = icons();
    if (!m || m.getAppIconName() === want) return;
    m.setAlternateAppIcon(want).catch(() => {});
  }, [want]);
  return null;
}

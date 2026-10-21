/**
 * When the Move Score app asks someone to have notifications on. Pure (shared with
 * the app through move-score-app/src/core); the prompt itself is
 * move-score-app/src/push/AlertsPrompt.tsx.
 *
 * - "first": the phone has never been asked (first open): a welcome card, then the
 *   system question. Once per install.
 * - "settings": notifications are blocked in the phone's Settings; the app can only
 *   send the person there. At most every NUDGE_DAYS.
 * - "enable": the phone allows them but the person switched alerts off in the app
 *   (Account → Alerts on this phone). At most every NUDGE_DAYS.
 */
import type { AlertsPermission } from "./alertsSwitch";

export type AlertsPrompt = "first" | "settings" | "enable";

/** How often an off or blocked phone is reminded. */
export const NUDGE_DAYS = 3;

export function alertsPromptFor(i: {
  supported: boolean;
  permission: AlertsPermission;
  /** The app's own switch (Account → Alerts on this phone). */
  wantAlerts: boolean;
  /** The first-open card (or the older after-follow question) has been shown. */
  asked: boolean;
  /** When this phone was last reminded, ms; null when never. */
  lastNudgeAt: number | null;
  nowMs: number;
}): AlertsPrompt | null {
  if (!i.supported) return null;
  if (i.permission === "undetermined") return i.asked ? null : "first";
  const due = i.lastNudgeAt === null || i.nowMs - i.lastNudgeAt >= NUDGE_DAYS * 86_400_000;
  if (!due) return null;
  if (i.permission === "denied") return "settings";
  return i.wantAlerts ? null : "enable";
}

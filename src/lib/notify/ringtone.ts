/**
 * The Move Score ringtone for calls: a master referee's call for assistance (migration 0035) and,
 * since 12 Nov 2026, a match's players called to their court. Pure: no database.
 */
import type { ExpoMessage } from "./drain";

/** Move Score 1.0.3 and later ring calls with their own ringtone (`master_alarm.wav`, Android channel `assistance_alarm`). */
export function ringsWithAlarm(appVersion: string | null | undefined): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(appVersion ?? "");
  if (!m) return false;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return a > 1 || (a === 1 && (b > 0 || c >= 3));
}

/**
 * The call's ringtone. With ASSISTANCE_CRITICAL_ALERTS=1 (only once Apple has granted Move Score the
 * Critical Alerts entitlement and phones run a build that carries it) it is a critical alert: an
 * iPhone plays it at full volume even on silent and in Focus. Android already rings it as an alarm.
 */
export function alarmSound(): ExpoMessage["sound"] {
  return process.env.ASSISTANCE_CRITICAL_ALERTS === "1" ? { critical: true, name: "master_alarm.wav", volume: 1 } : "master_alarm.wav";
}

/** The alert kinds that ring a player's own phone like a call: called to court, and its reminder. */
export const PLAYER_CALL_KINDS: ReadonlySet<string> = new Set(["called_to_court", "call_reminder"]);

/** The push fields that make a player's own phone ring: ringtone, loud channel, through Focus, I'm coming / Decline buttons. */
export function playerCallPush(): Pick<ExpoMessage, "sound" | "channelId" | "priority" | "interruptionLevel" | "categoryId" | "ttl"> {
  return { sound: alarmSound(), channelId: "assistance_alarm", priority: "high", interruptionLevel: "time-sensitive", categoryId: "player_call", ttl: 600 };
}

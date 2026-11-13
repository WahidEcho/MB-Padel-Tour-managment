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

/**
 * The alert kinds that ring a player's own phone like a call: called to court, its reminder,
 * and the ring repeated every 15 s until the player answers (owner, 13 Nov 2026).
 */
export const PLAYER_CALL_KINDS: ReadonlySet<string> = new Set(["called_to_court", "call_reminder", "call_ring"]);

/** How often a called player's phone rings again until they answer, reach the court or the deadline passes. */
export const PLAYER_RING_EVERY_MS = 15_000;

/**
 * Builds after 1.0.5 carry the players' own ringtone (`player_call.wav`, a 15-second chime, and
 * the Android channel `player_call`); 1.0.3–1.0.5 ring with the master referee's alarm.
 */
export function hasPlayerRingtone(appVersion: string | null | undefined): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(appVersion ?? "");
  if (!m) return false;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return a > 1 || (a === 1 && (b > 0 || c >= 6));
}

/** The push fields that make a player's own phone ring: ringtone, loud channel, through Focus, I'm coming / Decline buttons. */
export function playerCallPush(appVersion?: string | null): Pick<ExpoMessage, "sound" | "channelId" | "priority" | "interruptionLevel" | "categoryId" | "ttl"> {
  const own = hasPlayerRingtone(appVersion);
  const name = own ? "player_call.wav" : "master_alarm.wav";
  const sound: ExpoMessage["sound"] = process.env.ASSISTANCE_CRITICAL_ALERTS === "1" ? { critical: true, name, volume: 1 } : name;
  return { sound, channelId: own ? "player_call" : "assistance_alarm", priority: "high", interruptionLevel: "time-sensitive", categoryId: "player_call", ttl: 600 };
}

/** A player's call alerts that share one notification per match on their own phone. */
const CALL_NOTIFICATION_KINDS: ReadonlySet<string> = new Set([...PLAYER_CALL_KINDS, "call_withdrawn"]);

/**
 * Extra push data for a player's own phone (owner, 13 Nov 2026). Android 1.0.6+ (patched
 * expo-notifications) reads `notifTag` as the notification's id, so each repeat ring and the
 * withdrawal replace the match's call notification, and `countdownUntil` (epoch ms) as a live
 * countdown to the deadline on the lock screen that goes away when the deadline passes. Older
 * builds and iPhones (which count down on the Live Activity) ignore both.
 */
export function playerCallData(kind: string, url: string, countdownUntil: string | null | undefined, nowMs = Date.now()): { notifTag?: string; countdownUntil?: number } {
  if (!CALL_NOTIFICATION_KINDS.has(kind)) return {};
  const m = /^movescore:\/\/match\/([0-9a-f-]{36})/i.exec(url);
  if (!m) return {};
  const until = kind === "call_withdrawn" || !countdownUntil ? NaN : Date.parse(countdownUntil);
  return { notifTag: `call:${m[1].toLowerCase()}`, ...(Number.isFinite(until) && until > nowMs ? { countdownUntil: until } : {}) };
}

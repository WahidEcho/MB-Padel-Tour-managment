/**
 * The code shown at the venue gate that upgrades a pass to its on-site edition.
 *
 * It rotates every WINDOW_SECONDS, so a photo of it posted online stops working
 * within a minute. A printed poster can't rotate, so staff can also read out a
 * daily six-digit code. Both are HMACs of a server secret: nothing is stored.
 */
import { createHmac } from "crypto";

export const WINDOW_SECONDS = 45;

function secret(): string {
  const s = process.env.VENUE_QR_SECRET || process.env.AUTH_SECRET;
  if (!s) throw new Error("VENUE_QR_SECRET or AUTH_SECRET must be set");
  return s;
}

function mac(input: string): Buffer {
  return createHmac("sha256", secret()).update(input).digest();
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function rotatingCode(groupSlug: string, atMs = Date.now()): string {
  const w = Math.floor(atMs / 1000 / WINDOW_SECONDS);
  const b = mac(`venue:${groupSlug}:${w}`);
  let s = "";
  for (let i = 0; i < 8; i++) s += ALPHABET[b[i]! % ALPHABET.length];
  return s;
}

/** Six digits for the given day in the event's zone (YYYY-MM-DD). */
export function dailyCode(groupSlug: string, day: string): string {
  const n = mac(`venue:${groupSlug}:day:${day}`).readUInt32BE(0) % 1_000_000;
  return String(n).padStart(6, "0");
}

/** The event's calendar day for an instant. */
export function eventDay(timeZone: string, atMs = Date.now()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(atMs));
  return parts;
}

/**
 * Whether a day (YYYY-MM-DD, the event's zone) is one of the event's days. Without
 * dates every day counts; with only a start, the event is that one day.
 */
export function isEventDay(day: string, startsOn: string | null, endsOn: string | null): boolean {
  if (!startsOn) return true;
  return day >= startsOn && day <= (endsOn ?? startsOn);
}

/** Accepts the current and the previous window, and today's daily code. */
export function checkVenueCode(groupSlug: string, code: string, timeZone: string, atMs = Date.now()): boolean {
  const c = code.trim().toUpperCase();
  if (!c) return false;
  if (c === rotatingCode(groupSlug, atMs) || c === rotatingCode(groupSlug, atMs - WINDOW_SECONDS * 1000)) return true;
  return /^\d{6}$/.test(c) && c === dailyCode(groupSlug, eventDay(timeZone, atMs));
}

export function venueUrl(siteOrigin: string, groupSlug: string, code: string): string {
  return `${siteOrigin.replace(/\/$/, "")}/v/${encodeURIComponent(groupSlug)}?c=${encodeURIComponent(code)}`;
}

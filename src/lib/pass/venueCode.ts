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

/* ---------- match check-in ----------
 * The same signed codes, scoped to one match. The court TV shows a code that
 * rotates every MATCH_WINDOW_SECONDS (?c=); a printed code at the court can't
 * rotate, so it is fixed per match (?p=) and only the server's check-in window
 * (src/lib/pass/attendance.ts) bounds when it works.
 *
 *   https://<site>/m/<match id>?c=<8 chars>   court TV
 *   https://<site>/m/<match id>?p=<10 chars>  printed
 */

export const MATCH_WINDOW_SECONDS = 60;
/** How far back an old TV code is still recognised, to say "expired" rather than "wrong". */
const MATCH_EXPIRED_LOOKBACK_WINDOWS = 180;

function letters(input: string, n: number): string {
  const b = mac(input);
  let s = "";
  for (let i = 0; i < n; i++) s += ALPHABET[b[i]! % ALPHABET.length];
  return s;
}

const matchWindow = (atMs: number) => Math.floor(atMs / 1000 / MATCH_WINDOW_SECONDS);

export function matchScreenCode(matchId: string, atMs = Date.now()): string {
  return letters(`match:${matchId}:${matchWindow(atMs)}`, 8);
}

export function matchPrintedCode(matchId: string): string {
  return letters(`match:${matchId}:print`, 10);
}

export type MatchCodeCheck = { ok: true; via: "screen" | "printed" } | { ok: false; reason: "bad_code" | "code_expired" };

/** Accepts the TV's current and previous code, or the printed one. */
export function checkMatchCode(matchId: string, code: { c?: string | null; p?: string | null }, atMs = Date.now()): MatchCodeCheck {
  const p = String(code.p ?? "").trim().toUpperCase();
  if (p) return p === matchPrintedCode(matchId) ? { ok: true, via: "printed" } : { ok: false, reason: "bad_code" };
  const c = String(code.c ?? "").trim().toUpperCase();
  if (!c) return { ok: false, reason: "bad_code" };
  const w = matchWindow(atMs);
  const at = (k: number) => letters(`match:${matchId}:${w - k}`, 8);
  if (c === at(0) || c === at(1)) return { ok: true, via: "screen" };
  for (let k = 2; k <= MATCH_EXPIRED_LOOKBACK_WINDOWS; k++) if (c === at(k)) return { ok: false, reason: "code_expired" };
  return { ok: false, reason: "bad_code" };
}

export function matchCheckinUrl(siteOrigin: string, matchId: string, code: { c: string } | { p: string }): string {
  const [k, v] = "c" in code ? ["c", code.c] : ["p", code.p];
  return `${siteOrigin.replace(/\/$/, "")}/m/${encodeURIComponent(matchId)}?${k}=${encodeURIComponent(v)}`;
}

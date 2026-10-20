/**
 * Referee PINs and calls for assistance (migration 0035): the pure rules. No Node,
 * browser or Next.js APIs, so the server, the web console and the app share them
 * (the app through `@core`). Hashing lives in pin.ts (server only); the server side
 * in server.ts and assistance.ts. Docs: docs/referees.md.
 */
/** The event-code alphabet (src/lib/orgs/codes.ts, which is server-only), repeated so this file stays pure. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const isCodeShaped = (s: string) => s.length === 12 && [...s].every((ch) => CODE_ALPHABET.includes(ch));

export const REFEREE_ROLES = ["referee", "master_referee"] as const;
export type RefereeRole = (typeof REFEREE_ROLES)[number];
export const isRefereeRole = (r: unknown): r is RefereeRole => typeof r === "string" && (REFEREE_ROLES as readonly string[]).includes(r);

export const REFEREE_ROLE_LABELS: Record<RefereeRole, string> = { referee: "Referee", master_referee: "Master referee" };

export const PIN_LENGTH = 4;

/**
 * PIN brakes (audit H1, owner-approved 20 Oct 2026; failed attempts only, a right PIN is
 * refunded; src/lib/referees/server.ts checkRefereePin). After the court code the referee
 * picks their own name, so a PIN is only ever checked against that one referee.
 * - per referee: PIN_LOCK.limit wrong PINs within the window lock that referee (not the
 *   code, not the court, not the others) for PIN_LOCK_MINUTES from the last one;
 * - per organisation: every wrong PIN of its referees counts in PIN_ORG_TIERS; when a tier
 *   fills, PIN sign-in of new devices pauses until it empties (10 min, then 1 h, then a
 *   day: a growing backoff) and the organisation's owners and admins are alerted;
 * - known device: a phone or browser that signed in as that referee in the last
 *   KNOWN_DEVICE_HOURS gets back in with the right PIN even while the referee or the
 *   organisation is locked (its wrong PINs still count for the organisation and against
 *   PIN_PER_DEVICE);
 * - per address: only a ceiling against scripts (a venue's Wi-Fi or a mobile carrier puts
 *   every referee behind one address);
 * - never per court code: a typo on Court 3 never locks Court 3.
 * Move Score 1.0.1 cannot pick a name: its "<code> <PIN>" is matched across the
 * organisation's referees under organisation-wide budgets only (PIN_ORG_TIERS and the
 * tighter PIN_LEGACY_ORG_TIERS; docs/referees.md).
 */
export const PIN_LOCK_MINUTES = 5;
export const PIN_LOCK = { limit: 5, windowSeconds: PIN_LOCK_MINUTES * 60 };
export const PIN_PER_DEVICE = { limit: 5, windowSeconds: PIN_LOCK_MINUTES * 60 };
export const PIN_ORG_TIERS = [
  { limit: 25, windowSeconds: 10 * 60 },
  { limit: 60, windowSeconds: 60 * 60 },
  { limit: 150, windowSeconds: 24 * 3600 },
] as const;
/**
 * Move Score 1.0.1's nameless "<code> <PIN>" tests the PIN against every referee the code
 * lists, so its wrong PINs also fill a tighter organisation-wide budget of their own.
 */
export const PIN_LEGACY_ORG_TIERS = [
  { limit: 10, windowSeconds: 10 * 60 },
  { limit: 30, windowSeconds: 24 * 3600 },
] as const;
export const PIN_PER_IP = { limit: 300, windowSeconds: 15 * 60 };
export const KNOWN_DEVICE_HOURS = 24;

/** A referee to pick on the PIN step: the name (and photo) only, never a phone. */
export interface RefereeChoice {
  id: string;
  name: string;
  photoUrl: string | null;
}

/** The names on the PIN step that match what was typed in its search box. */
export function filterRefereeChoices<T extends { name: string }>(list: T[], query: string): T[] {
  const q = query.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
  if (!q) return list;
  return list.filter((r) => r.name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || r.name.toLowerCase().includes(q));
}

/** "On court now": a referee seen within this many minutes still counts as on court. */
export const ON_COURT_MINUTES = 20;

/** A PIN as typed: exactly four digits (spaces ignored); null otherwise. */
export function normalizePin(input: unknown): string | null {
  if (typeof input !== "string" && typeof input !== "number") return null;
  const s = String(input).replace(/\s+/g, "");
  return /^\d{4}$/.test(s) ? s : null;
}

/** PINs too easy to guess to hand out: one digit repeated, or a run up or down (1234, 9876). */
export function isWeakPin(pin: string): boolean {
  if (!/^\d{4}$/.test(pin)) return true;
  if (/^(\d)\1{3}$/.test(pin)) return true;
  const d = [...pin].map(Number);
  const up = d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  const down = d.every((x, i) => i === 0 || x === d[i - 1] - 1);
  return up || down;
}

/**
 * Move Score 1.0.1 has one field for the code. A referee types the court code and the
 * PIN in it: "K7QM-W3XT-9HRP-4821", "K7QM-W3XT-9HRP 4821", "K7QMW3XT9HRP4821".
 * Returns the code part and the PIN when the input is exactly that; null otherwise
 * (a bare code, a password, anything else).
 */
export function splitCodeAndPin(input: unknown): { code: string; pin: string } | null {
  if (typeof input !== "string" || input.length > 60) return null;
  const s = input.toUpperCase().replace(/[\s\-–—_.]/g, "");
  if (s.length !== 12 + PIN_LENGTH) return null;
  const code = s.slice(0, 12);
  const pin = normalizePin(s.slice(12));
  return isCodeShaped(code) && pin ? { code, pin } : null;
}

/* ---------------- calls for assistance ---------------- */

export type CallStatus = "open" | "acknowledged" | "resolved" | "cancelled";
export type CallAction = "acknowledge" | "resolve" | "cancel";

/** A call still waiting for (or with) a master referee. */
export const isOpenCall = (s: CallStatus) => s === "open" || s === "acknowledged";

/**
 * The call's next status after `action` by `who`, or null when it is not allowed:
 * - "On my way" (acknowledge): a master referee, on an open call;
 * - resolve: a master referee or the organiser's staff, on an open or acknowledged call;
 * - cancel: the court referee who called, while nobody has answered yet; the organiser's staff too.
 * A resolved or cancelled call never changes again.
 */
export function nextCallStatus(current: CallStatus, action: CallAction, who: "master" | "court" | "staff"): CallStatus | null {
  if (!isOpenCall(current)) return null;
  if (action === "acknowledge") return who === "master" && current === "open" ? "acknowledged" : null;
  if (action === "resolve") return who === "master" || who === "staff" ? "resolved" : null;
  if (action === "cancel") return (who === "court" && current === "open") || who === "staff" ? "cancelled" : null;
  return null;
}

/** Calls per court: at most this many new calls in the window (taps on an open call never count). */
export const CALLS_PER_COURT = { limit: 6, windowSeconds: 10 * 60 };
/** Taps within this many seconds of the last one are the same tap (no new alert). */
export const TAP_DEDUPE_SECONDS = 30;
/** An open call is alerted again (to masters who have not answered) at most this often. */
export const REALERT_SECONDS = 60;

/** Whether another tap on an open call re-alerts the masters (not within REALERT_SECONDS of the last alert). */
export function shouldRealert(call: { status: CallStatus; last_tap_at: string }, nowMs = Date.now()): boolean {
  if (call.status !== "open") return false;
  const last = Date.parse(call.last_tap_at);
  return !Number.isFinite(last) || nowMs - last >= REALERT_SECONDS * 1000;
}

/** "Referee Sara is calling for assistance at Court 3". */
export function assistanceMessage(refereeName: string, court: string): string {
  return `Referee ${refereeName.trim()} is calling for assistance at ${court.trim()}`;
}

/** The answer a court referee sees. */
export function callStatusLine(call: { status: CallStatus; acknowledged_by_name?: string | null; resolved_by_name?: string | null }): string {
  if (call.status === "open") return "Calling the master referees…";
  if (call.status === "acknowledged") return `${call.acknowledged_by_name ?? "A master referee"} is on the way`;
  if (call.status === "resolved") return `Resolved${call.resolved_by_name ? ` by ${call.resolved_by_name}` : ""}`;
  return "Call cancelled";
}

/**
 * "Open now · closes 21:00" / "Opens tomorrow 09:00": the live chip on the
 * event info screen, worked out on the event's own wall clock (the phone may be
 * in another zone; the hours are the venue's). Opening hours are per calendar
 * day in that zone and never run past midnight (the sanitiser refuses it).
 *
 * Pure module: no database, no framework. Shared with the app through @core.
 */
import type { EventInfoDay } from "./types";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Closing within this many minutes reads "Closing soon". */
export const CLOSING_SOON_MINUTES = 30;

/** The wall clock in `timeZone` at an instant: its calendar day and minutes past midnight. */
export function wallClock(atMs: number, timeZone: string): { date: string; minutes: number } {
  let parts: Record<string, string>;
  try {
    parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
        .formatToParts(new Date(atMs))
        .map((p) => [p.type, p.value]),
    );
  } catch {
    // An unknown zone: read the hours in UTC rather than not at all.
    const d = new Date(atMs);
    return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
  }
  const hour = Number(parts.hour) % 24;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: hour * 60 + Number(parts.minute) };
}

const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** The day after "2026-11-02". */
export function nextDay(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** "Mon 2 Nov". */
export function dayLabel(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(d.getTime())) return date;
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "2–8 Nov 2026", "30 Oct – 2 Nov 2026", "2 Nov 2026"; "" without a start. */
export function dateSpan(startsOn: string | null | undefined, endsOn: string | null | undefined): string {
  if (!startsOn) return "";
  const a = new Date(`${startsOn}T12:00:00Z`);
  const b = new Date(`${endsOn || startsOn}T12:00:00Z`);
  if (!Number.isFinite(a.getTime()) || !Number.isFinite(b.getTime())) return "";
  const am = MONTHS[a.getUTCMonth()];
  const bm = MONTHS[b.getUTCMonth()];
  if (startsOn === (endsOn || startsOn)) return `${a.getUTCDate()} ${am} ${a.getUTCFullYear()}`;
  if (a.getUTCFullYear() !== b.getUTCFullYear()) return `${a.getUTCDate()} ${am} ${a.getUTCFullYear()} – ${b.getUTCDate()} ${bm} ${b.getUTCFullYear()}`;
  if (am !== bm) return `${a.getUTCDate()} ${am} – ${b.getUTCDate()} ${bm} ${b.getUTCFullYear()}`;
  return `${a.getUTCDate()}–${b.getUTCDate()} ${am} ${a.getUTCFullYear()}`;
}

export type OpenState =
  | { kind: "open"; closes: string; closingSoon: boolean; day: EventInfoDay }
  | { kind: "opens"; opens: string; when: "today" | "tomorrow" | "later"; day: EventInfoDay }
  | { kind: "over" }
  /** Hours are given, but none from today on has times yet. */
  | { kind: "unknown" };

const timed = (d: EventInfoDay) => !d.closed && Boolean(d.opens && d.closes);

/** Where the venue stands at `nowMs`; null when no hours are given at all. */
export function openState(hours: EventInfoDay[], nowMs: number, timeZone: string): OpenState | null {
  if (!hours.length) return null;
  const now = wallClock(nowMs, timeZone);
  const sorted = [...hours].sort((a, b) => a.date.localeCompare(b.date));
  const today = sorted.find((d) => d.date === now.date);
  if (today && timed(today)) {
    const o = toMinutes(today.opens);
    const c = toMinutes(today.closes);
    if (now.minutes < o) return { kind: "opens", opens: today.opens, when: "today", day: today };
    if (now.minutes < c) return { kind: "open", closes: today.closes, closingSoon: c - now.minutes <= CLOSING_SOON_MINUTES, day: today };
  }
  const next = sorted.find((d) => d.date > now.date && timed(d));
  if (next) return { kind: "opens", opens: next.opens, when: next.date === nextDay(now.date) ? "tomorrow" : "later", day: next };
  const last = sorted[sorted.length - 1];
  if (last.date < now.date || (today && sorted.every((d) => d.date <= now.date))) return { kind: "over" };
  return { kind: "unknown" };
}

/** The chip's words. */
export function openLabel(s: OpenState): string {
  switch (s.kind) {
    case "open":
      return s.closingSoon ? `Closing soon · ${s.closes}` : `Open now · closes ${s.closes}`;
    case "opens":
      return s.when === "today" ? `Opens today ${s.opens}` : s.when === "tomorrow" ? `Opens tomorrow ${s.opens}` : `Opens ${dayLabel(s.day.date)} · ${s.opens}`;
    case "over":
      return "The event is over";
    case "unknown":
      return "Hours to be confirmed";
  }
}

/** Today's row (in the event's zone), if the organiser listed today. */
export function todayHours(hours: EventInfoDay[], nowMs: number, timeZone: string): EventInfoDay | null {
  const { date } = wallClock(nowMs, timeZone);
  return hours.find((d) => d.date === date) ?? null;
}

/** "09:00 – 21:00", "Closed", or "Hours to be confirmed". */
export function hoursLine(d: EventInfoDay): string {
  if (d.closed) return "Closed";
  if (d.opens && d.closes) return `${d.opens} – ${d.closes}`;
  return "Hours to be confirmed";
}

/** Every day from `startsOn` to `endsOn` (at most 31), for the editor's rows. */
export function eventDays(startsOn: string | null | undefined, endsOn: string | null | undefined): string[] {
  if (!startsOn) return [];
  const out: string[] = [];
  let d = startsOn;
  const end = endsOn && endsOn >= startsOn ? endsOn : startsOn;
  while (d <= end && out.length < 31) {
    out.push(d);
    d = nextDay(d);
  }
  return out;
}

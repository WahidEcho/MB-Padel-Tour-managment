/**
 * Dates, times and numbers in the app's language, through Intl. Pure (no React
 * Native), so plain modules and tests use it too. The clock is always 24-hour,
 * as at the events: "14:30" in every language.
 *
 *   en "Tue 20 Oct" · es "mar, 20 oct" · fr "mar. 20 oct."
 */
import type { Lang } from "./translate";

/** The Intl locale for each language (British English keeps the day-first dates). */
export const INTL_LOCALE: Record<Lang, string> = { en: "en-GB", es: "es-ES", fr: "fr-FR" };

type When = string | number | Date;

function toDate(x: When): Date {
  return x instanceof Date ? x : new Date(x);
}

function format(lang: Lang, x: When, opts: Intl.DateTimeFormatOptions, fallback: (d: Date) => string): string {
  const d = toDate(x);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(INTL_LOCALE[lang], opts).format(d);
  } catch {
    try {
      // An unknown time zone: the phone's own.
      const { timeZone: _ignored, ...rest } = opts;
      return new Intl.DateTimeFormat(INTL_LOCALE[lang], rest).format(d);
    } catch {
      return fallback(d);
    }
  }
}

const iso = (d: Date) => d.toISOString();

export function formatters(lang: Lang) {
  const tz = (timeZone?: string | null) => (timeZone ? { timeZone } : {});
  return {
    lang,
    locale: INTL_LOCALE[lang],
    /** "14:30". */
    time: (x: When, timeZone?: string | null) => format(lang, x, { ...tz(timeZone), hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, (d) => iso(d).slice(11, 16)),
    /** "Tue 20 Oct". */
    day: (x: When, timeZone?: string | null) => format(lang, x, { ...tz(timeZone), weekday: "short", day: "numeric", month: "short" }, (d) => iso(d).slice(0, 10)),
    /** "Tuesday 20 October". */
    dayLong: (x: When, timeZone?: string | null) => format(lang, x, { ...tz(timeZone), weekday: "long", day: "numeric", month: "long" }, (d) => iso(d).slice(0, 10)),
    /** "20 Oct". */
    dayMonth: (x: When, timeZone?: string | null) => format(lang, x, { ...tz(timeZone), day: "numeric", month: "short" }, (d) => iso(d).slice(5, 10)),
    /** "20 Oct 2026". */
    date: (x: When, timeZone?: string | null) => format(lang, x, { ...tz(timeZone), day: "numeric", month: "short", year: "numeric" }, (d) => iso(d).slice(0, 10)),
    /** "October 2026". */
    month: (x: When, timeZone?: string | null) => format(lang, x, { ...tz(timeZone), month: "long", year: "numeric" }, (d) => iso(d).slice(0, 7)),
    /** "Tue" / "Tuesday". */
    weekday: (x: When, long = false, timeZone?: string | null) => format(lang, x, { ...tz(timeZone), weekday: long ? "long" : "short" }, (d) => iso(d).slice(0, 10)),
    /** Any other Intl options, in the app's language. */
    custom: (x: When, opts: Intl.DateTimeFormatOptions) => format(lang, x, opts, (d) => iso(d)),
    /** "1,234" / "1.234" / "1 234". */
    number: (n: number, opts?: Intl.NumberFormatOptions) => {
      try {
        return new Intl.NumberFormat(INTL_LOCALE[lang], opts).format(n);
      } catch {
        return String(n);
      }
    },
  };
}

export type Formatters = ReturnType<typeof formatters>;

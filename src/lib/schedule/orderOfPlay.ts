/**
 * The order of play by day and court: what a fan reads to know who plays where
 * and when, for a whole day at a glance. Pure and framework-free (shared with the
 * Move Score app through `@core`): the app's Schedule tab and the public web ties
 * page draw the same grouping.
 *
 * A day is the tournament's own calendar day (its time zone), never the phone's.
 * Items without a time sit after the timed item before them on their court
 * ("followed by"), and items with no time and no court day at all go to the
 * "to be scheduled" day at the end of the picker.
 */

export type ScheduleStatus = "live" | "scheduled" | "done";
export type ScheduleMode = "court" | "time";

export interface ScheduleItem {
  id: string;
  courtId: string | null;
  scheduledTime: string | null;
  /** The organiser's order of play (tie_order / match_order). */
  order: number;
  status: ScheduleStatus;
  /** When an item has no scheduled time, the day it was actually played. */
  startedAt?: string | null;
  endedAt?: string | null;
}

export interface ScheduleCourt {
  id: string;
  name: string;
  order?: number;
}

export interface ScheduleGroup<T> {
  key: string;
  /** Court name (by court), "10:00" (by time), or the "to be confirmed" bucket. */
  title: string;
  courtId: string | null;
  /** "HH:MM" in the event's zone for a time group; null otherwise. */
  time: string | null;
  items: T[];
}

export interface DaySchedule<T> {
  /** Everything on court now, whatever day is picked: pinned at the top. */
  live: T[];
  groups: ScheduleGroup<T>[];
}

/** The picker's bucket for items with no day yet. */
export const TBC_DAY = "tbc";
export const NO_COURT_TITLE = "Court to be confirmed";
export const NO_TIME_TITLE = "Time to be confirmed";

/** "2026-11-02": the instant's calendar day in the event's zone. */
export function dayKeyIn(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return TBC_DAY;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return iso.slice(0, 10);
  }
}

/** "10:30" in the event's zone. */
export function clockIn(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

/** The day an item belongs to: its scheduled time, else when it was played, else "to be scheduled". */
export function itemDay(item: Pick<ScheduleItem, "scheduledTime" | "startedAt" | "endedAt">, timeZone: string): string {
  const at = item.scheduledTime ?? item.startedAt ?? item.endedAt ?? null;
  return at ? dayKeyIn(at, timeZone) : TBC_DAY;
}

/** Every day with play, in calendar order; the "to be scheduled" bucket last. */
export function scheduleDays(items: ScheduleItem[], timeZone: string): string[] {
  const days = new Set(items.map((x) => itemDay(x, timeZone)));
  const dated = [...days].filter((d) => d !== TBC_DAY).sort();
  return days.has(TBC_DAY) ? [...dated, TBC_DAY] : dated;
}

/**
 * The day the picker opens on: today when it has play, else the next day with
 * play, else the last day played. The "to be scheduled" bucket only when it is
 * all there is.
 */
export function defaultScheduleDay(days: string[], today: string): string | null {
  const dated = days.filter((d) => d !== TBC_DAY);
  if (!dated.length) return days[0] ?? null;
  if (dated.includes(today)) return today;
  return dated.find((d) => d > today) ?? dated[dated.length - 1];
}

/** "Mon 2 Nov" for a day key; "To be scheduled" for the bucket. */
export function scheduleDayLabel(day: string): string {
  if (day === TBC_DAY) return "To be scheduled";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(`${day}T12:00:00Z`));
}

/**
 * One court's items in playing order. Sorted by the organiser's order first;
 * an item without a time then carries the time of the item before it ("followed
 * by"), so a court reads 10:00, followed by, not before 14:00 even when the
 * order numbers were entered across courts.
 */
function playingOrder<T extends ScheduleItem>(list: T[]): T[] {
  const byOrder = [...list].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  let carried = Number.NEGATIVE_INFINITY;
  const keyed = byOrder.map((x, i) => {
    const at = x.scheduledTime ? Date.parse(x.scheduledTime) : Number.NaN;
    if (!Number.isNaN(at)) carried = at;
    return { x, time: carried, i };
  });
  return keyed.sort((a, b) => (a.time === b.time ? a.i - b.i : a.time - b.time)).map((k) => k.x);
}

/**
 * The picked day's order of play, grouped by court (in the venue's court order,
 * unknown courts last) or by start time ("Not before" slots, untimed last).
 */
export function scheduleForDay<T extends ScheduleItem>(
  items: T[],
  o: { day: string; timeZone: string; courts: ScheduleCourt[]; mode: ScheduleMode },
): DaySchedule<T> {
  const live = playingOrder(items.filter((x) => x.status === "live"));
  const today = items.filter((x) => itemDay(x, o.timeZone) === o.day);
  const courtRank = new Map(o.courts.map((c, i) => [c.id, c.order ?? i] as const));
  const courtName = new Map(o.courts.map((c) => [c.id, c.name] as const));
  const known = (id: string | null) => (id && courtName.has(id) ? id : null);

  if (o.mode === "court") {
    const byCourt = new Map<string | null, T[]>();
    for (const x of today) {
      const k = known(x.courtId);
      byCourt.set(k, [...(byCourt.get(k) ?? []), x]);
    }
    const keys = [...byCourt.keys()].sort((a, b) => {
      if (a === null) return 1;
      if (b === null) return -1;
      return (courtRank.get(a) ?? 0) - (courtRank.get(b) ?? 0) || courtName.get(a)!.localeCompare(courtName.get(b)!);
    });
    return {
      live,
      groups: keys.map((k) => ({
        key: k ?? "no-court",
        title: k ? courtName.get(k)! : NO_COURT_TITLE,
        courtId: k,
        time: null,
        items: playingOrder(byCourt.get(k)!),
      })),
    };
  }

  const bySlot = new Map<string | null, T[]>();
  for (const x of today) {
    const k = x.scheduledTime ? clockIn(x.scheduledTime, o.timeZone) : null;
    bySlot.set(k, [...(bySlot.get(k) ?? []), x]);
  }
  const rank = (x: T) => {
    const k = known(x.courtId);
    return k ? (courtRank.get(k) ?? 0) : Number.MAX_SAFE_INTEGER;
  };
  const slots = [...bySlot.keys()].sort((a, b) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)));
  return {
    live,
    groups: slots.map((k) => ({
      key: k ?? "no-time",
      title: k ?? NO_TIME_TITLE,
      courtId: null,
      time: k,
      items: [...bySlot.get(k)!].sort((a, b) => rank(a) - rank(b) || a.order - b.order || a.id.localeCompare(b.id)),
    })),
  };
}

/** The event's calendar day (YYYY-MM-DD) in its own time zone, as the server stamps it. */
export function eventToday(timeZone: string | null | undefined, at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timeZone || "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
    const part = (type: string) => parts.find((p) => p.type === type)?.value;
    const [y, m, d] = [part("year"), part("month"), part("day")];
    if (y && m && d) return `${y}-${m}-${d}`;
  } catch {
    /* no time zone data on this engine: fall back to UTC */
  }
  return at.toISOString().slice(0, 10);
}

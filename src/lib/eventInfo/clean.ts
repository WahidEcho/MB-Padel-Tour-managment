/**
 * The event info sanitiser: what the admin form posts (or what is stored) in,
 * clean content out, with the problems that make a save refused. Plain text
 * only (tags and angle brackets removed, control and bidi-override characters
 * dropped), lengths capped, links https only (map links on map hosts only),
 * phones as E.164, times as 24 h "HH:MM" and days as "YYYY-MM-DD".
 *
 * The public read runs the same function over the stored document and ignores
 * the problems, so a hand-edited row can never put more than this on a phone.
 *
 * Pure module: no database, no framework.
 */
import { toE164 } from "../players/phone";
import type { Admission, EventInfoContact, EventInfoContent, EventInfoDay, EventInfoDirections, EventInfoDoc, EventInfoEntry, EventInfoFaq } from "./types";

export const EVENT_INFO_LIMITS = {
  intro: 200,
  ticketsNote: 600,
  url: 500,
  listItems: 15,
  listItem: 100,
  paragraph: 600,
  hours: 31,
  dayNote: 120,
  address: 200,
  landmark: 200,
  dropOff: 300,
  transit: 400,
  parking: 800,
  food: 800,
  contacts: 4,
  contactLabel: 40,
  email: 120,
  faqs: 20,
  question: 160,
  answer: 800,
} as const;

const L = EVENT_INFO_LIMITS;

/** Control characters (keeping newline and tab), zero-width space, bidi embeddings, overrides and isolates. */
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​‪-‮⁦-⁩]/g;

/** Plain text: no tags, no angle brackets, no invisible controls; one line unless `multiline`. */
export function plainText(value: unknown, multiline = false): string {
  let s = typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
  s = s.replace(/\r\n?/g, "\n").replace(/<\/?[a-z!][^>]*>/gi, "").replace(/[<>]/g, "").replace(INVISIBLE, "").replace(/\t/g, " ");
  if (!multiline) return s.replace(/\s+/g, " ").trim();
  return s
    .split("\n")
    .map((line) => line.replace(/ {2,}/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Hosts a "Google Maps" / "Apple Maps" share link may be on. */
const GOOGLE_MAP_HOST = /^(?:(?:www|maps)\.)?google\.(?:com|com\.eg|co\.uk|[a-z]{2})$|^(?:maps\.app\.)?goo\.gl$|^g\.page$/;
const APPLE_MAP_HOST = /^maps\.apple\.(?:com|ca)$/;

/** An https URL without credentials (on one of `hosts` when given), as a string; "" when unusable. */
export function httpsUrl(value: unknown, hosts?: RegExp): string {
  const raw = plainText(value);
  if (!raw) return "";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "";
  }
  if (u.protocol !== "https:" || u.username || u.password || !u.hostname.includes(".")) return "";
  if (hosts && !hosts.test(u.hostname.toLowerCase())) return "";
  const out = u.toString();
  return out.length <= L.url ? out : "";
}

/** "9:00" → "09:00"; "" when not a 24 h time. */
export function hhmm(value: unknown): string {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(plainText(value));
  if (!m) return "";
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return "";
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

/** "2026-11-02" when it is a real calendar day; "" otherwise. */
export function isoDay(value: unknown): string {
  const s = plainText(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return "";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? s : "";
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Lines of a list: an array, or a textarea's text one item per line (leading bullets dropped). */
function listOf(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split("\n") : [];
  return items.map((x) => plainText(x).replace(/^[-•*·]\s*/, "")).filter(Boolean);
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim().replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export interface CleanResult {
  content: EventInfoContent;
  /** Why the admin's save is refused (empty: fine). */
  problems: string[];
}

/** Clean content from anything shaped roughly like EventInfoContent. */
export function cleanEventInfo(input: unknown): CleanResult {
  const problems: string[] = [];
  const raw = obj(input);

  const text = (value: unknown, max: number, label: string, multiline = false): string => {
    const s = plainText(value, multiline);
    if (s.length > max) {
      problems.push(`${label}: keep it to ${max} characters (it has ${s.length}).`);
      return s.slice(0, max).trim();
    }
    return s;
  };
  const link = (value: unknown, label: string, hosts?: RegExp, hostsLabel?: string): string => {
    const given = plainText(value);
    if (!given) return "";
    const u = httpsUrl(given, hosts);
    if (!u) problems.push(`${label}: use a full https:// link${hostsLabel ? ` from ${hostsLabel}` : ""}.`);
    return u;
  };
  const list = (value: unknown, label: string): string[] => {
    const items = listOf(value);
    if (items.length > L.listItems) problems.push(`${label}: at most ${L.listItems} lines.`);
    return items.slice(0, L.listItems).map((x, i) => text(x, L.listItem, `${label}, line ${i + 1}`));
  };

  const intro = text(raw.intro, L.intro, "Welcome line");

  const e = obj(raw.entry);
  const admission: Admission = e.admission === "free" || e.admission === "tickets" ? e.admission : "";
  const entry: EventInfoEntry = {
    admission,
    ticketsNote: text(e.ticketsNote, L.ticketsNote, "Tickets", true),
    ticketsUrl: link(e.ticketsUrl, "Tickets link"),
    allowed: list(e.allowed, "Allowed"),
    notAllowed: list(e.notAllowed, "Not allowed"),
    kids: text(e.kids, L.paragraph, "Kids", true),
    photography: text(e.photography, L.paragraph, "Photography", true),
    other: text(e.other, L.paragraph, "Other entry rules", true),
  };

  const hours: EventInfoDay[] = [];
  const seen = new Set<string>();
  const rawHours = arr(raw.hours);
  if (rawHours.length > L.hours) problems.push(`Opening hours: at most ${L.hours} days.`);
  for (const h0 of rawHours.slice(0, L.hours)) {
    const h = obj(h0);
    const givenDate = plainText(h.date);
    const date = isoDay(givenDate);
    const opensGiven = plainText(h.opens);
    const closesGiven = plainText(h.closes);
    const closed = h.closed === true || h.closed === "on" || h.closed === "true";
    const note = text(h.note, L.dayNote, `Note for ${givenDate || "a day"}`);
    if (!givenDate && !opensGiven && !closesGiven && !note && !closed) continue;
    if (!date) {
      problems.push(`Opening hours: "${givenDate || "(no day)"}" is not a day (YYYY-MM-DD).`);
      continue;
    }
    if (seen.has(date)) {
      problems.push(`Opening hours: ${date} is listed twice.`);
      continue;
    }
    seen.add(date);
    if (closed) {
      hours.push({ date, opens: "", closes: "", note, closed: true });
      continue;
    }
    if (!opensGiven && !closesGiven) {
      // A day with only a note: kept, with no times ("Hours to be confirmed").
      if (note) hours.push({ date, opens: "", closes: "", note, closed: false });
      continue;
    }
    const opens = hhmm(opensGiven);
    const closes = hhmm(closesGiven);
    if (!opens || !closes) {
      problems.push(`Opening hours on ${date}: give both times as 24 h HH:MM (e.g. 09:00 and 21:00).`);
      continue;
    }
    if (closes <= opens) {
      problems.push(`Opening hours on ${date}: closing (${closes}) must be after opening (${opens}).`);
      continue;
    }
    hours.push({ date, opens, closes, note, closed: false });
  }
  hours.sort((a, b) => a.date.localeCompare(b.date));

  const d = obj(raw.directions);
  let lat = num(d.lat);
  let lng = num(d.lng);
  if ((lat === null) !== (lng === null) || (lat !== null && (lat < -90 || lat > 90)) || (lng !== null && (lng < -180 || lng > 180))) {
    problems.push("Directions: give both latitude and longitude (decimal degrees), or neither.");
    lat = null;
    lng = null;
  }
  const directions: EventInfoDirections = {
    address: text(d.address, L.address, "Address"),
    landmark: text(d.landmark, L.landmark, "Nearest landmark"),
    dropOff: text(d.dropOff, L.dropOff, "Taxi / Uber drop-off", true),
    transit: text(d.transit, L.transit, "Public transport", true),
    lat: lat === null ? null : Math.round(lat * 1e6) / 1e6,
    lng: lng === null ? null : Math.round(lng * 1e6) / 1e6,
    googleMapsUrl: link(d.googleMapsUrl, "Google Maps link", GOOGLE_MAP_HOST, "Google Maps"),
    appleMapsUrl: link(d.appleMapsUrl, "Apple Maps link", APPLE_MAP_HOST, "Apple Maps (maps.apple.com)"),
  };

  const contacts: EventInfoContact[] = [];
  const rawContacts = arr(raw.contacts);
  if (rawContacts.length > L.contacts) problems.push(`Contacts: at most ${L.contacts}.`);
  rawContacts.slice(0, L.contacts).forEach((c0, i) => {
    const c = obj(c0);
    const label = text(c.label, L.contactLabel, `Contact ${i + 1} name`);
    const phoneGiven = plainText(c.phone);
    const emailGiven = plainText(c.email);
    if (!label && !phoneGiven && !emailGiven) return;
    const phone = phoneGiven ? toE164(phoneGiven) : null;
    if (phoneGiven && !phone) problems.push(`Contact ${i + 1}: "${phoneGiven}" is not a phone number (use +20 1xx xxx xxxx).`);
    const email = emailGiven && emailGiven.length <= L.email && EMAIL.test(emailGiven) ? emailGiven.toLowerCase() : "";
    if (emailGiven && !email) problems.push(`Contact ${i + 1}: "${emailGiven.slice(0, 60)}" is not an email address.`);
    if (!phone && !email) {
      if (label) problems.push(`Contact ${i + 1} (${label}): add a phone number or an email.`);
      return;
    }
    const whatsapp = Boolean(phone) && (c.whatsapp === true || c.whatsapp === "on" || c.whatsapp === "true");
    contacts.push({ label: label || "Tournament desk", phone: phone ?? "", whatsapp, email });
  });

  const faqs: EventInfoFaq[] = [];
  const rawFaqs = arr(raw.faqs);
  if (rawFaqs.length > L.faqs) problems.push(`FAQ: at most ${L.faqs} questions.`);
  rawFaqs.slice(0, L.faqs).forEach((f0, i) => {
    const f = obj(f0);
    const q = text(f.q, L.question, `Question ${i + 1}`);
    const a = text(f.a, L.answer, `Answer ${i + 1}`, true);
    if (!q && !a) return;
    if (!q || !a) {
      problems.push(`FAQ ${i + 1}: give both the question and its answer.`);
      return;
    }
    faqs.push({ q, a });
  });

  return {
    content: {
      intro,
      entry,
      hours,
      directions,
      parking: text(raw.parking, L.parking, "Parking", true),
      food: text(raw.food, L.food, "Food & drinks", true),
      contacts,
      faqs,
    },
    problems,
  };
}

/** The stored document, cleaned; null when there is none. */
export function readEventInfoDoc(stored: unknown): EventInfoDoc | null {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
  const raw = stored as Record<string, unknown>;
  const { content } = cleanEventInfo(raw);
  return {
    schema: 1,
    ...content,
    published: raw.published === true,
    updatedAt: typeof raw.updatedAt === "string" && raw.updatedAt.length <= 40 ? raw.updatedAt : "",
  };
}

/** Whether the content says anything at all (an empty page is never published). */
export function hasContent(c: EventInfoContent): boolean {
  const e = c.entry;
  const d = c.directions;
  return Boolean(
    c.intro ||
      e.admission ||
      e.ticketsNote ||
      e.ticketsUrl ||
      e.allowed.length ||
      e.notAllowed.length ||
      e.kids ||
      e.photography ||
      e.other ||
      c.hours.length ||
      d.address ||
      d.landmark ||
      d.dropOff ||
      d.transit ||
      d.lat !== null ||
      d.googleMapsUrl ||
      d.appleMapsUrl ||
      c.parking ||
      c.food ||
      c.contacts.length ||
      c.faqs.length,
  );
}

/** Rows the admin form posts per repeated block. */
export const FORM_ROWS = { contacts: 4, faqsMin: 6, hoursMin: 7 } as const;

/**
 * The admin form's fields as raw content for cleanEventInfo. Repeated blocks are
 * numbered: hours_date_0, contact_phone_1, faq_q_2 …; `hours_rows` / `faq_rows`
 * say how many the form rendered (capped, so a forged count costs nothing).
 */
export function rawFromForm(form: { get(name: string): unknown }): Record<string, unknown> {
  const s = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : "";
  };
  const count = (k: string, max: number) => Math.max(0, Math.min(max, Math.floor(Number(s(k)) || 0)));
  const hours = Array.from({ length: count("hours_rows", L.hours) }, (_, i) => ({
    date: s(`hours_date_${i}`),
    opens: s(`hours_opens_${i}`),
    closes: s(`hours_closes_${i}`),
    note: s(`hours_note_${i}`),
    closed: s(`hours_closed_${i}`) === "on",
  }));
  const contacts = Array.from({ length: FORM_ROWS.contacts }, (_, i) => ({
    label: s(`contact_label_${i}`),
    phone: s(`contact_phone_${i}`),
    whatsapp: s(`contact_whatsapp_${i}`) === "on",
    email: s(`contact_email_${i}`),
  }));
  const faqs = Array.from({ length: count("faq_rows", L.faqs) }, (_, i) => ({ q: s(`faq_q_${i}`), a: s(`faq_a_${i}`) }));
  return {
    intro: s("intro"),
    entry: {
      admission: s("admission"),
      ticketsNote: s("tickets_note"),
      ticketsUrl: s("tickets_url"),
      allowed: s("allowed"),
      notAllowed: s("not_allowed"),
      kids: s("kids"),
      photography: s("photography"),
      other: s("entry_other"),
    },
    hours,
    directions: {
      address: s("address"),
      landmark: s("landmark"),
      dropOff: s("drop_off"),
      transit: s("transit"),
      lat: s("lat"),
      lng: s("lng"),
      googleMapsUrl: s("google_maps_url"),
      appleMapsUrl: s("apple_maps_url"),
    },
    parking: s("parking"),
    food: s("food"),
    contacts,
    faqs,
  };
}

/** A branding config without the stored event info (public tournament payloads). */
export function withoutEventInfo<B extends { eventInfo?: unknown } | null | undefined>(branding: B): B {
  if (!branding || !("eventInfo" in branding)) return branding;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { eventInfo, ...rest } = branding;
  return rest as B;
}

import { describe, expect, it } from "vitest";
import { cleanEventInfo, hasContent, hhmm, httpsUrl, isoDay, plainText, rawFromForm, readEventInfoDoc } from "./clean";
import { dateSpan, dayLabel, eventDays, hoursLine, openLabel, openState, todayHours, wallClock } from "./hours";
import { directionLinks, telLink, whatsAppLink } from "./links";
import { publicEventInfo } from "./public";
import type { EventInfoDay } from "./types";

const CAIRO = "Africa/Cairo";
/** An instant given as Cairo wall clock (Cairo is UTC+2 in November 2026: no summer time then). */
const cairo = (local: string) => Date.parse(`${local}:00+02:00`);

const DAYS: EventInfoDay[] = [
  { date: "2026-11-02", opens: "09:00", closes: "21:00", note: "", closed: false },
  { date: "2026-11-03", opens: "09:00", closes: "21:00", note: "", closed: false },
  { date: "2026-11-04", opens: "", closes: "", note: "Rest day", closed: true },
  { date: "2026-11-05", opens: "10:00", closes: "18:00", note: "", closed: false },
];

describe("plain text", () => {
  it("drops tags, angle brackets and invisible controls", () => {
    expect(plainText("<b>Hello</b> <script>alert(1)</script>world")).toBe("Hello alert(1)world");
    expect(plainText("a < b > c")).toBe("a b c");
    expect(plainText("x‮y\u0007z​")).toBe("xyz");
    expect(plainText("  one   line \n two ")).toBe("one line two");
  });
  it("keeps paragraphs when multiline, at most one blank line", () => {
    expect(plainText(" a \n\n\n\n b  c \r\n d", true)).toBe("a\n\nb c\nd");
  });
  it("keeps Arabic", () => {
    expect(plainText("مرحبا بكم")).toBe("مرحبا بكم");
  });
});

describe("links, times and days", () => {
  it("https only, no credentials, optional hosts", () => {
    expect(httpsUrl("https://tickets.example.com/x")).toBe("https://tickets.example.com/x");
    expect(httpsUrl("http://tickets.example.com")).toBe("");
    expect(httpsUrl("javascript:alert(1)")).toBe("");
    expect(httpsUrl("https://user:pw@example.com")).toBe("");
    expect(httpsUrl("https://maps.app.goo.gl/abc", /^maps\.app\.goo\.gl$/)).toBe("https://maps.app.goo.gl/abc");
    expect(httpsUrl("https://evil.example/maps", /^maps\.app\.goo\.gl$/)).toBe("");
  });
  it("times as 24 h HH:MM", () => {
    expect(hhmm("9:00")).toBe("09:00");
    expect(hhmm("21.30")).toBe("21:30");
    expect(hhmm("24:00")).toBe("");
    expect(hhmm("9am")).toBe("");
  });
  it("real calendar days only", () => {
    expect(isoDay("2026-11-02")).toBe("2026-11-02");
    expect(isoDay("2026-02-30")).toBe("");
    expect(isoDay("02/11/2026")).toBe("");
  });
});

describe("cleanEventInfo", () => {
  it("cleans a full document without problems", () => {
    const { content, problems } = cleanEventInfo({
      intro: "Welcome to the <i>Junior Finals</i>",
      entry: { admission: "free", allowed: "- Water\n• Hats\n\n", notAllowed: ["Drones"], kids: "Under 12s with an adult", ticketsUrl: "" },
      hours: [DAYS[1], DAYS[0], { date: "", opens: "", closes: "" }],
      directions: { address: "104 Airport Rd", lat: "30.1", lng: "31.4", googleMapsUrl: "https://maps.app.goo.gl/x1" },
      contacts: [{ label: "Desk", phone: "01001234567", whatsapp: true }, { label: "", phone: "", email: "" }],
      faqs: [{ q: "Is it free?", a: "Yes." }],
    });
    expect(problems).toEqual([]);
    expect(content.intro).toBe("Welcome to the Junior Finals");
    expect(content.entry.allowed).toEqual(["Water", "Hats"]);
    expect(content.hours.map((h) => h.date)).toEqual(["2026-11-02", "2026-11-03"]);
    expect(content.directions).toMatchObject({ lat: 30.1, lng: 31.4, googleMapsUrl: "https://maps.app.goo.gl/x1" });
    expect(content.contacts).toEqual([{ label: "Desk", phone: "+201001234567", whatsapp: true, email: "" }]);
    expect(hasContent(content)).toBe(true);
  });
  it("names every problem", () => {
    const { problems, content } = cleanEventInfo({
      intro: "x".repeat(201),
      entry: { ticketsUrl: "http://plain.example" },
      hours: [
        { date: "2026-11-02", opens: "21:00", closes: "09:00" },
        { date: "2026-11-03", opens: "9", closes: "21:00" },
        { date: "tomorrow", opens: "09:00", closes: "10:00" },
        { date: "2026-11-05", opens: "09:00", closes: "10:00" },
        { date: "2026-11-05", opens: "09:00", closes: "11:00" },
      ],
      directions: { lat: "30.1", googleMapsUrl: "https://example.com/map", appleMapsUrl: "https://maps.apple.com/?q=x" },
      contacts: [{ label: "Desk", phone: "12" }, { label: "Info", email: "nope" }],
      faqs: [{ q: "Only a question" }],
    });
    expect(problems.join("\n")).toMatch(/Welcome line: keep it to 200/);
    expect(problems.join("\n")).toMatch(/Tickets link: use a full https/);
    expect(problems.join("\n")).toMatch(/closing \(09:00\) must be after opening \(21:00\)/);
    expect(problems.join("\n")).toMatch(/2026-11-03: give both times/);
    expect(problems.join("\n")).toMatch(/"tomorrow" is not a day/);
    expect(problems.join("\n")).toMatch(/2026-11-05 is listed twice/);
    expect(problems.join("\n")).toMatch(/latitude and longitude/);
    expect(problems.join("\n")).toMatch(/Google Maps link: use a full https:\/\/ link from Google Maps/);
    expect(problems.join("\n")).toMatch(/Contact 1: "12" is not a phone number/);
    expect(problems.join("\n")).toMatch(/Contact 2: "nope" is not an email/);
    expect(problems.join("\n")).toMatch(/FAQ 1: give both/);
    expect(content.directions.appleMapsUrl).toBe("https://maps.apple.com/?q=x");
    expect(content.intro.length).toBe(200);
  });
  it("an empty document has no content and no problems", () => {
    const r = cleanEventInfo({});
    expect(r.problems).toEqual([]);
    expect(hasContent(r.content)).toBe(false);
  });
  it("a stored document is read through the same sanitiser", () => {
    const doc = readEventInfoDoc({ published: true, updatedAt: "2026-10-20T10:00:00.000Z", intro: "<img src=x onerror=alert(1)>Hi", entry: { ticketsUrl: "javascript:alert(1)" } });
    expect(doc).toMatchObject({ published: true, intro: "Hi", updatedAt: "2026-10-20T10:00:00.000Z" });
    expect(doc!.entry.ticketsUrl).toBe("");
    expect(readEventInfoDoc(null)).toBeNull();
    expect(readEventInfoDoc({ published: "yes" })!.published).toBe(false);
  });
  it("reads the admin form's numbered fields", () => {
    const f = new Map<string, string>([
      ["intro", "Hello"],
      ["admission", "tickets"],
      ["hours_rows", "999"],
      ["hours_date_0", "2026-11-02"],
      ["hours_opens_0", "09:00"],
      ["hours_closes_0", "21:00"],
      ["hours_date_1", "2026-11-03"],
      ["hours_closed_1", "on"],
      ["contact_label_0", "Desk"],
      ["contact_phone_0", "+20 100 123 4567"],
      ["contact_whatsapp_0", "on"],
      ["faq_rows", "2"],
      ["faq_q_1", "Q"],
      ["faq_a_1", "A"],
    ]);
    const raw = rawFromForm({ get: (k) => f.get(k) ?? null });
    expect((raw.hours as unknown[]).length).toBe(31);
    const { content, problems } = cleanEventInfo(raw);
    expect(problems).toEqual([]);
    expect(content.entry.admission).toBe("tickets");
    expect(content.hours).toEqual([
      { date: "2026-11-02", opens: "09:00", closes: "21:00", note: "", closed: false },
      { date: "2026-11-03", opens: "", closes: "", note: "", closed: true },
    ]);
    expect(content.contacts[0]).toEqual({ label: "Desk", phone: "+201001234567", whatsapp: true, email: "" });
    expect(content.faqs).toEqual([{ q: "Q", a: "A" }]);
  });
});

describe("open now", () => {
  it("reads the event's wall clock, not the phone's", () => {
    expect(wallClock(Date.parse("2026-11-02T22:30:00Z"), CAIRO)).toEqual({ date: "2026-11-03", minutes: 30 });
  });
  it("before opening, open, closing soon, after closing", () => {
    expect(openLabel(openState(DAYS, cairo("2026-11-02T08:15"), CAIRO)!)).toBe("Opens today 09:00");
    expect(openLabel(openState(DAYS, cairo("2026-11-02T12:00"), CAIRO)!)).toBe("Open now · closes 21:00");
    expect(openLabel(openState(DAYS, cairo("2026-11-02T20:40"), CAIRO)!)).toBe("Closing soon · 21:00");
    expect(openLabel(openState(DAYS, cairo("2026-11-02T21:00"), CAIRO)!)).toBe("Opens tomorrow 09:00");
  });
  it("skips a closed day and names the next one", () => {
    expect(openLabel(openState(DAYS, cairo("2026-11-03T22:00"), CAIRO)!)).toBe("Opens Thu 5 Nov · 10:00");
    expect(openLabel(openState(DAYS, cairo("2026-11-04T12:00"), CAIRO)!)).toBe("Opens tomorrow 10:00");
  });
  it("before the event and after it", () => {
    expect(openLabel(openState(DAYS, cairo("2026-10-20T12:00"), CAIRO)!)).toBe("Opens Mon 2 Nov · 09:00");
    expect(openLabel(openState(DAYS, cairo("2026-11-05T19:00"), CAIRO)!)).toBe("The event is over");
    expect(openLabel(openState(DAYS, cairo("2026-11-09T12:00"), CAIRO)!)).toBe("The event is over");
  });
  it("no hours: no chip; days without times: to be confirmed", () => {
    expect(openState([], Date.now(), CAIRO)).toBeNull();
    expect(openLabel(openState([{ date: "2026-11-08", opens: "", closes: "", note: "TBC", closed: false }], cairo("2026-11-02T12:00"), CAIRO)!)).toBe("Hours to be confirmed");
  });
  it("today's line and the event's days", () => {
    expect(hoursLine(todayHours(DAYS, cairo("2026-11-04T09:00"), CAIRO)!)).toBe("Closed");
    expect(hoursLine(todayHours(DAYS, cairo("2026-11-02T09:00"), CAIRO)!)).toBe("09:00 – 21:00");
    expect(todayHours(DAYS, cairo("2026-11-08T09:00"), CAIRO)).toBeNull();
    expect(eventDays("2026-11-02", "2026-11-08")).toEqual(["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"]);
    expect(eventDays("2026-10-30", "2026-11-01")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01"]);
  });
  it("labels", () => {
    expect(dayLabel("2026-11-02")).toBe("Mon 2 Nov");
    expect(dateSpan("2026-11-02", "2026-11-08")).toBe("2–8 Nov 2026");
    expect(dateSpan("2026-10-30", "2026-11-02")).toBe("30 Oct – 2 Nov 2026");
    expect(dateSpan("2026-11-02", null)).toBe("2 Nov 2026");
    expect(dateSpan(null, null)).toBe("");
  });
});

describe("links", () => {
  const base = { address: "", landmark: "", dropOff: "", transit: "", lat: null, lng: null, googleMapsUrl: "", appleMapsUrl: "" };
  it("share link, then coordinates, then the address or the venue", () => {
    expect(directionLinks({ ...base, googleMapsUrl: "https://maps.app.goo.gl/x" }).google).toBe("https://maps.app.goo.gl/x");
    const c = directionLinks({ ...base, lat: 30.1, lng: 31.4, address: "104 Airport Rd" });
    expect(c.google).toBe("https://www.google.com/maps/dir/?api=1&destination=30.1%2C31.4");
    expect(c.apple).toBe("https://maps.apple.com/?daddr=30.1%2C31.4&q=104%20Airport%20Rd");
    expect(directionLinks(base, "Smash Sporting Club, Cairo").google).toContain("destination=Smash%20Sporting%20Club%2C%20Cairo");
    expect(directionLinks(base)).toEqual({ google: null, apple: null });
  });
  it("call and WhatsApp", () => {
    expect(telLink("+201001234567")).toBe("tel:+201001234567");
    expect(whatsAppLink("+201001234567", "Hi")).toBe("https://wa.me/201001234567?text=Hi");
  });
});

describe("the public projection", () => {
  const event = { slug: "boys", eventName: "Junior Finals", venueName: "Smash Sporting Club", city: "Cairo", timezone: CAIRO, startsOn: "2026-11-02", endsOn: "2026-11-08" };
  it("published only, with links and only the known keys", () => {
    expect(publicEventInfo(readEventInfoDoc({ published: false, intro: "x" }), event, null)).toBeNull();
    expect(publicEventInfo(readEventInfoDoc({ published: true }), event, null)).toBeNull();
    const p = publicEventInfo(readEventInfoDoc({ published: true, intro: "Hi", updatedAt: "t" }), event, { places: { parking: "poi:p1" } })!;
    expect(p.links.google).toContain("Smash%20Sporting%20Club%2C%20Cairo");
    expect(p.map).toEqual({ places: { parking: "poi:p1" } });
    expect(Object.keys(p).sort()).toEqual(
      ["city", "contacts", "directions", "endsOn", "entry", "eventName", "faqs", "food", "hours", "intro", "links", "map", "parking", "slug", "startsOn", "timezone", "updatedAt", "venueName"].sort(),
    );
    expect(p).not.toHaveProperty("published");
  });
});

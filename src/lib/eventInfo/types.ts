/**
 * Event info for fans: entry rules, opening hours, getting there, parking, food,
 * contacts and FAQs. Written on the admin Event info tab, stored in the owner
 * tournament's `branding_config.eventInfo` (no migration; an event group's
 * tournaments share the first one's, like the venue map), read publicly through
 * GET /api/mobile/v1/t/<slug>/info and the web page /t/<slug>/info.
 *
 * Pure types: shared with the app through @core.
 */

/** Free entry, tickets, or not said yet. */
export type Admission = "free" | "tickets" | "";

export interface EventInfoEntry {
  admission: Admission;
  /** Prices, where to buy, what to show at the gate. */
  ticketsNote: string;
  /** Where to buy tickets (https only). */
  ticketsUrl: string;
  /** "Water bottles", "Small bags" … one short line each. */
  allowed: string[];
  notAllowed: string[];
  kids: string;
  photography: string;
  /** Anything else about getting in (dress code, ID, re-entry). */
  other: string;
}

/** One day's opening hours in the event's own time zone. */
export interface EventInfoDay {
  /** "2026-11-02". */
  date: string;
  /** "09:00" (24 h). Empty when the day is closed. */
  opens: string;
  /** "21:00", later than `opens` on the same day. */
  closes: string;
  /** "Finals day: gates close at 18:00". */
  note: string;
  closed: boolean;
}

export interface EventInfoDirections {
  address: string;
  /** "Opposite the Sheraton Al Matar gate". */
  landmark: string;
  /** Where a taxi / Uber should stop. */
  dropOff: string;
  /** Buses, metro, walking. */
  transit: string;
  /** The gate's position, for directions straight to it. */
  lat: number | null;
  lng: number | null;
  /** Share links copied from Google Maps / Apple Maps (map hosts only). */
  googleMapsUrl: string;
  appleMapsUrl: string;
}

export interface EventInfoContact {
  /** "Tournament desk". */
  label: string;
  /** E.164, "+201001234567". */
  phone: string;
  /** Offer "WhatsApp" next to "Call". */
  whatsapp: boolean;
  email: string;
}

export interface EventInfoFaq {
  q: string;
  a: string;
}

/** What the organiser writes (everything but the bookkeeping). */
export interface EventInfoContent {
  /** One welcoming line under the event's name. */
  intro: string;
  entry: EventInfoEntry;
  hours: EventInfoDay[];
  directions: EventInfoDirections;
  parking: string;
  food: string;
  contacts: EventInfoContact[];
  faqs: EventInfoFaq[];
}

/** As stored in `branding_config.eventInfo`. */
export interface EventInfoDoc extends EventInfoContent {
  schema: 1;
  /** Only published info is public. */
  published: boolean;
  /** Compare-and-set token for the editor: a save based on an older one is refused. */
  updatedAt: string;
}

/** Venue map places the info's tiles open the map on ("poi:<id>"), when a map is published. */
export type EventInfoPlace = "parking" | "food" | "toilets" | "medical" | "desk" | "entrance";
export const EVENT_INFO_PLACES: EventInfoPlace[] = ["parking", "food", "toilets", "medical", "desk", "entrance"];

/** GET /api/mobile/v1/t/<slug>/info. */
export interface PublicEventInfo extends EventInfoContent {
  /** The slug that was asked for (the app opens the venue map with it). */
  slug: string;
  /** The event's name: the group's ("Junior Finals 2026") or the tournament's. */
  eventName: string;
  venueName: string | null;
  city: string | null;
  timezone: string;
  startsOn: string | null;
  endsOn: string | null;
  /** Ready-made directions links (from the coordinates, the share links or the address). */
  links: { google: string | null; apple: string | null };
  /** The published venue map's places, or null when there is no public map. */
  map: { places: Partial<Record<EventInfoPlace, string>> } | null;
  updatedAt: string;
}

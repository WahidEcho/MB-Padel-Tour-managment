/**
 * What the public may read of the event info: published content only, its
 * fields named one by one (never the stored object as it is), the directions
 * links ready to open, and the venue map's places for the quick tiles.
 * Pure module.
 */
import { hasContent } from "./clean";
import { directionLinks } from "./links";
import type { EventInfoDoc, EventInfoPlace, PublicEventInfo } from "./types";

export interface EventInfoEvent {
  slug: string;
  eventName: string;
  venueName: string | null;
  city: string | null;
  timezone: string;
  startsOn: string | null;
  endsOn: string | null;
}

/** The venue map's category for each tile (src/lib/venue/categories.ts). */
const PLACE_CATEGORY: Record<EventInfoPlace, string> = {
  parking: "parking",
  food: "food",
  toilets: "toilets",
  medical: "medical",
  desk: "desk",
  entrance: "entrance",
};

const POI_ID = /^[A-Za-z0-9_-]{1,40}$/;

/** The first place of each category on the map (the main entrance for "entrance"), as "poi:<id>". */
export function placesFromPois(pois: { id: string; category: string; main?: boolean }[]): Partial<Record<EventInfoPlace, string>> {
  const out: Partial<Record<EventInfoPlace, string>> = {};
  for (const [place, category] of Object.entries(PLACE_CATEGORY) as [EventInfoPlace, string][]) {
    const of = pois.filter((p) => p.category === category && POI_ID.test(p.id));
    const pick = of.find((p) => p.main) ?? of[0];
    if (pick) out[place] = `poi:${pick.id}`;
  }
  return out;
}

export function publicEventInfo(doc: EventInfoDoc | null, event: EventInfoEvent, map: { places: Partial<Record<EventInfoPlace, string>> } | null): PublicEventInfo | null {
  if (!doc || !doc.published || !hasContent(doc)) return null;
  const fallbackPlace = [event.venueName, event.city].filter(Boolean).join(", ");
  return {
    slug: event.slug,
    eventName: event.eventName,
    venueName: event.venueName,
    city: event.city,
    timezone: event.timezone,
    startsOn: event.startsOn,
    endsOn: event.endsOn,
    intro: doc.intro,
    entry: {
      admission: doc.entry.admission,
      ticketsNote: doc.entry.ticketsNote,
      ticketsUrl: doc.entry.ticketsUrl,
      allowed: doc.entry.allowed,
      notAllowed: doc.entry.notAllowed,
      kids: doc.entry.kids,
      photography: doc.entry.photography,
      other: doc.entry.other,
    },
    hours: doc.hours.map((h) => ({ date: h.date, opens: h.opens, closes: h.closes, note: h.note, closed: h.closed })),
    directions: {
      address: doc.directions.address,
      landmark: doc.directions.landmark,
      dropOff: doc.directions.dropOff,
      transit: doc.directions.transit,
      lat: doc.directions.lat,
      lng: doc.directions.lng,
      googleMapsUrl: doc.directions.googleMapsUrl,
      appleMapsUrl: doc.directions.appleMapsUrl,
    },
    parking: doc.parking,
    food: doc.food,
    contacts: doc.contacts.map((c) => ({ label: c.label, phone: c.phone, whatsapp: c.whatsapp, email: c.email })),
    faqs: doc.faqs.map((f) => ({ q: f.q, a: f.a })),
    links: directionLinks(doc.directions, fallbackPlace),
    map,
    updatedAt: doc.updatedAt,
  };
}

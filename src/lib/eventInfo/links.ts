/**
 * The links behind the event info's buttons: directions in Google Maps and
 * Apple Maps, call and WhatsApp the desk. Pure module, shared with the app.
 */
import { whatsAppDigits } from "../players/phone";
import type { EventInfoDirections } from "./types";

/**
 * Directions links: the organiser's own share link first (it names the exact
 * gate), then the gate's coordinates, then the address (or the venue's name and
 * city). Null when there is nothing to route to.
 */
export function directionLinks(d: EventInfoDirections, fallbackPlace?: string | null): { google: string | null; apple: string | null } {
  const coords = d.lat !== null && d.lng !== null ? `${d.lat},${d.lng}` : null;
  const place = d.address || (fallbackPlace ?? "").trim() || null;
  const dest = coords ?? place;
  const google = d.googleMapsUrl || (dest ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}` : null);
  const apple = d.appleMapsUrl || (dest ? `https://maps.apple.com/?daddr=${encodeURIComponent(dest)}${coords && place ? `&q=${encodeURIComponent(place)}` : ""}` : null);
  return { google, apple };
}

export function telLink(e164: string): string {
  return `tel:${e164.replace(/[^\d+]/g, "")}`;
}

/** wa.me with an optional first message. */
export function whatsAppLink(e164: string, text?: string): string {
  return `https://wa.me/${whatsAppDigits(e164)}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

export function mailLink(email: string, subject?: string): string {
  return `mailto:${email}${subject ? `?subject=${encodeURIComponent(subject)}` : ""}`;
}

/**
 * Event info on the server: whose info a tournament shows, the editor's read and
 * write, and the public read. Server-only.
 *
 * Stored without a migration in `tournaments.branding_config.eventInfo` of the
 * owner tournament: a tournament in an event group uses the group's first
 * tournament (the boys' and girls' Junior Finals share one page, as they share
 * the venue map); a tournament on its own uses itself. The owner is always read
 * from the rows, never posted. Writes go through updateBranding's
 * compare-and-set, so a branding or live-video save in another tab is kept, and
 * the editor's `updatedAt` refuses a save based on an older version.
 */
import { db } from "../supabase";
import { memo } from "../mobile/http";
import { updateBranding } from "../backgroundStorage";
import { publicVenueBySlug } from "../venue/server";
import { readEventInfoDoc } from "./clean";
import { placesFromPois, publicEventInfo } from "./public";
import type { EventInfoContent, EventInfoDoc, PublicEventInfo } from "./types";

export interface EventInfoOwner {
  orgId: string;
  /** The tournament whose branding_config holds the info. */
  tournamentId: string;
  eventGroupId: string | null;
  /** Shown in the editor: "Junior Finals 2026 (every event of the group)". */
  label: string;
  eventName: string;
  venueName: string | null;
  city: string | null;
  timezone: string;
  startsOn: string | null;
  endsOn: string | null;
}

interface TRow {
  id: string;
  name: string;
  organization_id: string;
  event_group_id: string | null;
  venue_name: string | null;
  city: string | null;
  timezone: string | null;
  starts_on: string | null;
  ends_on: string | null;
}
interface GRow {
  id: string;
  name: string;
  organization_id: string;
  venue_name: string | null;
  city: string | null;
  timezone: string | null;
  starts_on: string | null;
  ends_on: string | null;
}

const T_COLUMNS = "id, name, organization_id, event_group_id, venue_name, city, timezone, starts_on, ends_on";

/** The info a tournament shows: its event group's (held by the group's first tournament), or its own. */
export async function eventInfoOwnerOf(tournamentId: string): Promise<EventInfoOwner | null> {
  const { data } = await db().from("tournaments").select(T_COLUMNS).eq("id", tournamentId).maybeSingle();
  const t = data as TRow | null;
  if (!t) return null;
  const own: EventInfoOwner = {
    orgId: t.organization_id,
    tournamentId: t.id,
    eventGroupId: null,
    label: t.name,
    eventName: t.name,
    venueName: t.venue_name,
    city: t.city,
    timezone: t.timezone || "Africa/Cairo",
    startsOn: t.starts_on,
    endsOn: t.ends_on,
  };
  if (!t.event_group_id) return own;
  const { data: g } = await db()
    .from("event_groups")
    .select("id, name, organization_id, venue_name, city, timezone, starts_on, ends_on")
    .eq("id", t.event_group_id)
    .eq("organization_id", t.organization_id)
    .maybeSingle();
  const group = g as GRow | null;
  if (!group) return own;
  const { data: first } = await db()
    .from("tournaments")
    .select("id, starts_on, ends_on")
    .eq("organization_id", t.organization_id)
    .eq("event_group_id", group.id)
    .eq("kind", "tournament")
    .order("created_at")
    .order("id")
    .limit(1);
  const holder = ((first ?? []) as { id: string }[])[0]?.id ?? t.id;
  return {
    orgId: t.organization_id,
    tournamentId: holder,
    eventGroupId: group.id,
    label: `${group.name} (every event of the group)`,
    eventName: group.name,
    venueName: group.venue_name ?? t.venue_name,
    city: group.city ?? t.city,
    timezone: group.timezone || t.timezone || "Africa/Cairo",
    startsOn: group.starts_on ?? t.starts_on,
    endsOn: group.ends_on ?? t.ends_on,
  };
}

/** The stored info of an owner, cleaned; null when none was saved yet. */
export async function readEventInfo(owner: EventInfoOwner): Promise<EventInfoDoc | null> {
  const { data } = await db().from("tournaments").select("branding_config").eq("id", owner.tournamentId).eq("organization_id", owner.orgId).maybeSingle();
  const b = (data as { branding_config: { eventInfo?: unknown } | null } | null)?.branding_config ?? null;
  return readEventInfoDoc(b?.eventInfo ?? null);
}

export type SaveEventInfoResult = { ok: true; before: EventInfoDoc | null; after: EventInfoDoc } | { ok: false; reason: "stale" | "failed" };

/**
 * Saves cleaned content. `basedOn` is the `updatedAt` the editor was opened on
 * ("" for a first save): a save based on an older version is refused as stale.
 */
export async function saveEventInfo(owner: EventInfoOwner, content: EventInfoContent, published: boolean, basedOn: string): Promise<SaveEventInfoResult> {
  const seen: { stale: boolean; before: EventInfoDoc | null } = { stale: false, before: null };
  const after: EventInfoDoc = { schema: 1, ...content, published, updatedAt: new Date().toISOString() };
  const written = await updateBranding(owner.tournamentId, (current) => {
    seen.before = readEventInfoDoc(current.eventInfo ?? null);
    seen.stale = (seen.before?.updatedAt ?? "") !== basedOn;
    return seen.stale ? current : { ...current, eventInfo: after };
  });
  if (seen.stale) return { ok: false, reason: "stale" };
  if (!written.ok) return { ok: false, reason: "failed" };
  return { ok: true, before: seen.before, after };
}

/* ---------------- public reads ---------------- */

async function publicTournamentId(slug: string): Promise<string | null> {
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) return null;
  const { data } = await db().from("tournaments").select("id").eq("slug", slug).eq("kind", "tournament").eq("public_access_enabled", true).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

/** The published info of a public tournament, as the public may read it; null otherwise. */
export function publicEventInfoBySlug(slug: string): Promise<PublicEventInfo | null> {
  return memo(`event-info:${slug}`, 5_000, async () => {
    const id = await publicTournamentId(slug);
    if (!id) return null;
    const owner = await eventInfoOwnerOf(id);
    if (!owner) return null;
    const doc = await readEventInfo(owner);
    if (!doc?.published) return null;
    const venue = await publicVenueBySlug(slug).catch(() => null);
    return publicEventInfo(
      doc,
      { slug, eventName: owner.eventName, venueName: owner.venueName, city: owner.city, timezone: owner.timezone, startsOn: owner.startsOn, endsOn: owner.endsOn },
      venue ? { places: placesFromPois(venue.doc.pois) } : null,
    );
  });
}

/** Whether a public tournament has published event info (for the web nav's "Info" link). */
export async function hasPublicEventInfo(slug: string): Promise<boolean> {
  return Boolean(await publicEventInfoBySlug(slug).catch(() => null));
}

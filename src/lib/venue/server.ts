/**
 * Venue maps on the server (migration 0039): which venue a tournament uses,
 * the editor's reads and writes, and the public reads (the projection in
 * public.ts, the live lines in live.ts). Server-only.
 *
 * A tournament in an event group uses the group's venue (the boys' and girls'
 * Junior Finals share Smash Sporting Club); a tournament on its own has its own.
 * The owner is always read from the tournament row, never posted.
 */
import { db } from "../supabase";
import { memo } from "../mobile/http";
import { getBundle, getLive } from "../mobile/server";
import { parseVenue } from "./validate";
import { toPublicVenue, type CourtRow } from "./public";
import { venueLive, type EventFeed } from "./live";
import type { PublicVenue, VenueDoc, VenueLive, VenueUnderlay } from "./types";

export interface VenueOwner {
  orgId: string;
  eventGroupId: string | null;
  tournamentId: string | null;
  /** Shown in the editor: "Junior Finals 2026 (both events)". */
  label: string;
}

export interface VenueRow {
  id: string;
  organization_id: string;
  event_group_id: string | null;
  tournament_id: string | null;
  name: string;
  doc: unknown;
  underlay: unknown;
  published: boolean;
  version: number;
  updated_at: string;
  updated_by: string | null;
}

const ROW_COLUMNS = "id, organization_id, event_group_id, tournament_id, name, doc, underlay, published, version, updated_at, updated_by";

/** The venue a tournament uses: its event group's, or its own. */
export async function venueOwnerOf(tournamentId: string): Promise<VenueOwner | null> {
  const { data } = await db().from("tournaments").select("id, name, organization_id, event_group_id").eq("id", tournamentId).maybeSingle();
  const t = data as { id: string; name: string; organization_id: string; event_group_id: string | null } | null;
  if (!t) return null;
  if (t.event_group_id) {
    const { data: g } = await db().from("event_groups").select("id, name, organization_id").eq("id", t.event_group_id).maybeSingle();
    const group = g as { id: string; name: string; organization_id: string } | null;
    if (group && group.organization_id === t.organization_id) return { orgId: t.organization_id, eventGroupId: group.id, tournamentId: null, label: `${group.name} (every event of the group)` };
  }
  return { orgId: t.organization_id, eventGroupId: null, tournamentId: t.id, label: t.name };
}

export async function venueRowOf(owner: VenueOwner): Promise<VenueRow | null> {
  let q = db().from("venue_maps").select(ROW_COLUMNS).eq("organization_id", owner.orgId);
  q = owner.eventGroupId ? q.eq("event_group_id", owner.eventGroupId) : q.eq("tournament_id", owner.tournamentId!);
  const { data } = await q.maybeSingle();
  return (data as VenueRow | null) ?? null;
}

/** The tournaments whose courts the venue's map shows (the group's, or the one). */
export async function venueTournaments(owner: VenueOwner, publicOnly: boolean): Promise<{ id: string; slug: string; name: string }[]> {
  let q = db().from("tournaments").select("id, slug, name").eq("organization_id", owner.orgId).eq("kind", "tournament");
  q = owner.eventGroupId ? q.eq("event_group_id", owner.eventGroupId) : q.eq("id", owner.tournamentId!);
  if (publicOnly) q = q.eq("public_access_enabled", true);
  const { data } = await q.order("created_at");
  return (data ?? []) as { id: string; slug: string; name: string }[];
}

export async function courtRowsOf(tournaments: { id: string; slug: string }[]): Promise<CourtRow[]> {
  if (!tournaments.length) return [];
  const { data } = await db().from("courts").select("id, tournament_id, court_name").in("tournament_id", tournaments.map((t) => t.id)).order("court_order");
  const slugOf = new Map(tournaments.map((t) => [t.id, t.slug]));
  return ((data ?? []) as { id: string; tournament_id: string; court_name: string }[]).map((c) => ({ slug: slugOf.get(c.tournament_id) ?? "", id: c.id, court_name: c.court_name }));
}

/** Saves the document (already parsed); bumps the version. */
export async function saveVenueDoc(owner: VenueOwner, doc: VenueDoc, published: boolean, actor: string): Promise<VenueRow> {
  const existing = await venueRowOf(owner);
  const now = new Date().toISOString();
  if (existing) {
    const { data, error } = await db()
      .from("venue_maps")
      .update({ doc, name: doc.name, published, version: existing.version + 1, updated_at: now, updated_by: actor })
      .eq("id", existing.id)
      .eq("organization_id", owner.orgId)
      .select(ROW_COLUMNS)
      .single();
    if (error) throw new Error(error.message);
    return data as VenueRow;
  }
  const { data, error } = await db()
    .from("venue_maps")
    .insert({ organization_id: owner.orgId, event_group_id: owner.eventGroupId, tournament_id: owner.tournamentId, doc, name: doc.name, published, updated_by: actor })
    .select(ROW_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return data as VenueRow;
}

export async function saveVenueUnderlay(row: VenueRow, underlay: VenueUnderlay | null, actor: string): Promise<void> {
  const { error } = await db()
    .from("venue_maps")
    .update({ underlay, updated_at: new Date().toISOString(), updated_by: actor })
    .eq("id", row.id)
    .eq("organization_id", row.organization_id);
  if (error) throw new Error(error.message);
}

/* ---------------- public reads ---------------- */

/** A public tournament by slug (the same rule as the app's public reads: tournaments only, public access on). */
async function publicTournament(slug: string): Promise<{ id: string; organization_id: string; event_group_id: string | null; timezone: string | null } | null> {
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) return null;
  const { data } = await db()
    .from("tournaments")
    .select("id, organization_id, event_group_id, timezone")
    .eq("slug", slug)
    .eq("kind", "tournament")
    .eq("public_access_enabled", true)
    .maybeSingle();
  return (data as { id: string; organization_id: string; event_group_id: string | null; timezone: string | null } | null) ?? null;
}

/** The published venue of a public tournament, as the public may read it; null otherwise. */
export function publicVenueBySlug(slug: string): Promise<PublicVenue | null> {
  return memo(`venue:${slug}`, 5_000, async () => {
    const t = await publicTournament(slug);
    if (!t) return null;
    const owner = (await venueOwnerOf(t.id))!;
    const row = await venueRowOf(owner);
    if (!row || !row.published) return null;
    const parsed = parseVenue(row.doc);
    if (!parsed.doc) return null;
    const tournaments = await venueTournaments(owner, true);
    const rows = await courtRowsOf(tournaments);
    return toPublicVenue(row, parsed.doc, rows, tournaments.map((x) => x.slug));
  });
}

/** Each court's live line, from the public bundle and live reads of every tournament on the map. */
export function venueLiveBySlug(slug: string): Promise<VenueLive | null> {
  return memo(`venue-live:${slug}`, 1_500, async () => {
    const venue = await publicVenueBySlug(slug);
    if (!venue) return null;
    const feeds: EventFeed[] = [];
    for (const s of venue.slugs) {
      const [bundle, live] = await Promise.all([getBundle(s), getLive(s)]);
      if (bundle && live) feeds.push({ slug: s, bundle, live, timezone: bundle.tournament.timezone });
    }
    return { generatedAt: new Date().toISOString(), courts: venueLive(venue.doc.courts, feeds) };
  });
}

/** Whether a public tournament has a published map (for "Show on map" buttons). */
export async function hasPublicVenue(slug: string): Promise<boolean> {
  return Boolean(await publicVenueBySlug(slug).catch(() => null));
}

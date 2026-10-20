import { notFound } from "next/navigation";
import Link from "next/link";
import { requireTournamentPage } from "@/lib/guard";
import { getTournament } from "@/lib/data";
import { courtRowsOf, venueOwnerOf, venueRowOf, venueTournaments } from "@/lib/venue/server";
import { parseVenue } from "@/lib/venue/validate";
import { parseUnderlay } from "@/lib/venue/underlay";
import VenueEditor from "./VenueEditor";

export const dynamic = "force-dynamic";

/**
 * The venue map editor: the site plan (image, DXF or SVG) under a 2D drawing of
 * the courts, buildings, walkways and points of interest; the anchor that ties
 * the plan to the world; warnings; JSON import / export; a 3D preview; and the
 * way to Survey mode on a phone. The venue is the event group's (both events of
 * the Junior Finals share one) or this tournament's own.
 */
export default async function VenuePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { scope } = await requireTournamentPage(id, ["admin", "manager"], `/admin/tournaments/${id}/venue`);
  const tournament = await getTournament(id);
  if (!tournament) notFound();
  const owner = await venueOwnerOf(id);
  if (!owner || owner.orgId !== scope.orgId) notFound();
  const row = await venueRowOf(owner);
  const tournaments = await venueTournaments(owner, false);
  const courtRows = await courtRowsOf(tournaments);
  const doc = row ? parseVenue(row.doc).doc : null;
  const underlay = row ? parseUnderlay(row.underlay ?? null).underlay : null;

  return (
    <div className="space-y-4" data-testid="venue-editor-page">
      <section className="card flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="font-bold">Venue map — {owner.label}</h2>
          <p className="text-sm text-muted">
            The 3D map with directions in the app and at <code>/t/{tournament.slug}/map</code>. Draw on the site plan, then stand at each place with a phone in Survey mode
            to pin it to its real GPS position.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/admin/tournaments/${id}/venue/survey`} className="btn-secondary text-xs" data-testid="venue-survey-link">
            Survey mode (phone)
          </Link>
          {row?.published && (
            <Link href={`/t/${tournament.slug}/map`} target="_blank" className="btn-secondary text-xs">
              Public map ↗
            </Link>
          )}
        </div>
      </section>
      <VenueEditor
        tournamentId={id}
        initialDoc={doc}
        initialUnderlay={underlay}
        published={row?.published ?? false}
        version={row?.version ?? 0}
        courtRows={courtRows}
        slugs={tournaments.map((t) => t.slug)}
      />
    </div>
  );
}

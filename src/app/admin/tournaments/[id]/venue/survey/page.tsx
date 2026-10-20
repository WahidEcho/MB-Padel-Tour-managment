import { notFound } from "next/navigation";
import Link from "next/link";
import { requireTournamentPage } from "@/lib/guard";
import { venueOwnerOf, venueRowOf } from "@/lib/venue/server";
import { parseVenue } from "@/lib/venue/validate";
import { featureList } from "@/lib/venue/survey";
import SurveyClient from "./SurveyClient";

export const dynamic = "force-dynamic";

/**
 * Survey mode, on a phone at the venue: pick a feature, stand on it, "Save this
 * spot" averages a few seconds of GPS fixes and stores the position (or uses it
 * as a reference spot that lines the whole plan up).
 */
export default async function VenueSurveyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { scope } = await requireTournamentPage(id, ["admin", "manager"], `/admin/tournaments/${id}/venue/survey`);
  const owner = await venueOwnerOf(id);
  if (!owner || owner.orgId !== scope.orgId) notFound();
  const row = await venueRowOf(owner);
  const doc = row ? parseVenue(row.doc).doc : null;
  return (
    <div className="mx-auto max-w-md space-y-3" data-testid="venue-survey">
      <div className="flex items-center justify-between">
        <h2 className="font-bold">Survey mode</h2>
        <Link href={`/admin/tournaments/${id}/venue`} className="text-xs font-semibold text-muted underline">
          Back to the editor
        </Link>
      </div>
      {!doc ? (
        <p className="card text-sm">Save the venue first (or load the sample layout) in the editor.</p>
      ) : (
        <SurveyClient tournamentId={id} features={featureList(doc)} geo={doc.geo} sample={Boolean(doc.sample)} />
      )}
    </div>
  );
}

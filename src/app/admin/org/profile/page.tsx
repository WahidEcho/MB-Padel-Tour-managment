import { notFound } from "next/navigation";
import { db } from "@/lib/supabase";
import { requireStaff } from "@/lib/guard";
import { staffCan } from "@/lib/auth";
import StateForm from "@/components/StateForm";
import ImageInput from "@/components/ImageInput";
import { cleanColors, cleanVenues, ORG_LIMITS } from "@/lib/orgs/profile";
import { updateOrgProfile } from "./actions";

export const dynamic = "force-dynamic";

/** The organisation's public profile in the app, and the branding its tournaments default to. Owners and admins. */
export default async function OrgProfilePage() {
  const staff = await requireStaff(["admin", "manager"], "/admin/org/profile");
  if (!staffCan(staff, "manage_org_profile") || staff.scopeTournamentId) notFound();
  const { data } = await db()
    .from("organizations")
    .select("id, slug, name, pending_name, logo_url, colors, about, city, country, venues, top_board_opt_out")
    .eq("id", staff.orgId)
    .maybeSingle();
  const org = data as {
    id: string;
    slug: string;
    name: string;
    pending_name: string | null;
    logo_url: string | null;
    colors: unknown;
    about: string | null;
    city: string | null;
    country: string | null;
    venues: unknown;
    top_board_opt_out: boolean;
  } | null;
  if (!org) notFound();
  const colors = cleanColors(org.colors);
  const venues = cleanVenues(org.venues);
  const rows = Array.from({ length: Math.min(ORG_LIMITS.venues, venues.length + 2) }, (_, i) => venues[i] ?? null);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Profile and branding</h1>
      <p className="text-xs text-muted">
        What the Move Score app shows on {org.name}&apos;s page (movescore: <span className="font-mono">org/{org.slug}</span>). The
        colours and logo are also the default look of the organisation&apos;s tournaments in the app, unless a tournament sets
        its own.
      </p>
      <StateForm action={updateOrgProfile} className="card space-y-4" testId="org-profile">
        <input type="hidden" name="organization_id" value={org.id} />
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="org-name">Name</label>
            <input id="org-name" name="name" defaultValue={org.name} required maxLength={ORG_LIMITS.name} className="input" />
            <p className="mt-1 text-xs text-muted" data-testid="org-name-note">
              {org.pending_name
                ? `"${org.pending_name}" is waiting for Move Beyond's approval.`
                : "A new name is checked by Move Beyond before it shows anywhere."}
            </p>
          </div>
          <div>
            <label className="label" htmlFor="org-city">City</label>
            <input id="org-city" name="city" defaultValue={org.city ?? ""} maxLength={ORG_LIMITS.city} className="input" />
          </div>
          <div>
            <label className="label" htmlFor="org-country">Country</label>
            <input id="org-country" name="country" defaultValue={org.country ?? ""} maxLength={ORG_LIMITS.country} className="input" />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="org-about">About</label>
            <textarea id="org-about" name="about" defaultValue={org.about ?? ""} maxLength={ORG_LIMITS.about} rows={4} className="input" />
          </div>
        </div>

        <fieldset className="grid gap-3 sm:grid-cols-3">
          <legend className="label">Branding (colours as #rrggbb; empty for none)</legend>
          <div>
            <label className="label" htmlFor="org-primary">Main colour</label>
            <input id="org-primary" name="color_primary" defaultValue={colors.primary ?? ""} placeholder="#0a7cff" pattern="#[0-9a-fA-F]{6}" maxLength={7} className="input font-mono" />
          </div>
          <div>
            <label className="label" htmlFor="org-accent">Second colour</label>
            <input id="org-accent" name="color_accent" defaultValue={colors.accent ?? ""} placeholder="#ff5a1f" pattern="#[0-9a-fA-F]{6}" maxLength={7} className="input font-mono" />
          </div>
          <div>
            <label className="label" htmlFor="org-logo">Logo (PNG, JPEG or WebP, up to 2 MB)</label>
            {org.logo_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={org.logo_url} alt={`${org.name} logo`} className="mb-2 h-12 w-auto rounded" />
            )}
            <ImageInput name="logo" accept="image/png,image/jpeg,image/webp" />
            {org.logo_url && (
              <label className="mt-1 flex items-center gap-2 text-xs">
                <input type="checkbox" name="remove_logo" /> Remove the logo
              </label>
            )}
          </div>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="label">Venues</legend>
          {rows.map((v, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[2fr_3fr_1fr]">
              <input name={`venue_${i}_name`} defaultValue={v?.name ?? ""} maxLength={ORG_LIMITS.venueName} placeholder="Venue name" className="input" aria-label={`Venue ${i + 1} name`} />
              <input name={`venue_${i}_address`} defaultValue={v?.address ?? ""} maxLength={ORG_LIMITS.venueAddress} placeholder="Address" className="input" aria-label={`Venue ${i + 1} address`} />
              <input name={`venue_${i}_courts`} type="number" min={0} max={ORG_LIMITS.courts} defaultValue={v?.courts ?? ""} placeholder="Courts" className="input" aria-label={`Venue ${i + 1} courts`} />
            </div>
          ))}
          <p className="text-xs text-muted">Leave a venue&apos;s name empty to remove it. Save to get more empty rows.</p>
        </fieldset>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="top_board_opt_out" defaultChecked={org.top_board_opt_out} /> Leave our players out of Move Score&apos;s
          platform-wide top boards
        </label>
        <button className="btn-primary">Save</button>
      </StateForm>
    </div>
  );
}

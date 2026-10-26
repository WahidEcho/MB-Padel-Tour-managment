"use server";

import { revalidatePath } from "next/cache";
import { requireTournamentPermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { refuse, tournamentRowRefusal } from "@/lib/rowGuards";
import { updateBranding } from "@/lib/backgroundStorage";
import { formResult, refusal, type FormState } from "@/lib/refusal";
import { courtTvFromForm } from "@/lib/tennis/courtTv";

/**
 * Admin → Screens → Court TV design: the display switches, the palette, the event
 * logo for light screens and the partner logos beside it. Written with a
 * compare-and-set on the row (updateBranding), so a branding save elsewhere is
 * never lost.
 */
export async function saveCourtTv(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = String(formData.get("tournament_id") ?? "");
  const { staff } = await requireTournamentPermission("manage_tournament", id);
  // A friendly session's hidden row has no court TV of its own.
  refuse(await tournamentRowRefusal(id));
  return formResult(async () => {
    const parsed = courtTvFromForm(formData);
    if (parsed.problems.length) refusal(parsed.problems.join(" "));
    const written = await updateBranding(id, (current) => {
      const next = { ...current, courtTv: parsed.settings, headerPartners: parsed.partners };
      if (parsed.eventLogoLightUrl) next.eventLogoLightUrl = parsed.eventLogoLightUrl;
      else delete next.eventLogoLightUrl;
      return next;
    });
    if (!written.ok) refusal("Could not save the court TV settings. Reload the page and try again.");
    await audit({
      tournament_id: id,
      actor_role: staff.role,
      action: "COURT_TV_SET",
      entity_type: "tournament",
      entity_id: id,
      new_value: { courtTv: parsed.settings, headerPartners: parsed.partners, eventLogoLightUrl: parsed.eventLogoLightUrl || null },
    });
    revalidatePath(`/admin/tournaments/${id}/screens`);
    return "Saved. The court TVs pick it up within a few seconds.";
  });
}

"use server";

import { revalidatePath } from "next/cache";
import { requireTournamentPermission } from "@/lib/guard";
import { refuse, tournamentRowRefusal } from "@/lib/rowGuards";
import { audit } from "@/lib/audit";
import { formResult, refusal, type FormState } from "@/lib/refusal";
import { cleanEventInfo, hasContent, rawFromForm } from "@/lib/eventInfo/clean";
import { eventInfoOwnerOf, saveEventInfo } from "@/lib/eventInfo/server";

/**
 * Event info for fans (no migration: the owner tournament's
 * branding_config.eventInfo). The action names only the tournament: whose info
 * it edits (the event group's, or the tournament's own) is read from the rows,
 * so no posted id can reach another organisation's info. Admins and managers of
 * the organisation (manage_tournament).
 */
export async function saveEventInfoAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = String(formData.get("tournament_id") ?? "");
  const { staff, scope } = await requireTournamentPermission("manage_tournament", id);
  refuse(await tournamentRowRefusal(id));
  return formResult(async () => {
    const owner = await eventInfoOwnerOf(id);
    if (!owner || owner.orgId !== scope.orgId) throw new Error("Not found");
    const { content, problems } = cleanEventInfo(rawFromForm(formData));
    if (problems.length) refusal(`Not saved: ${problems.slice(0, 4).join(" ")}${problems.length > 4 ? ` (+${problems.length - 4} more)` : ""}`);
    const published = formData.get("published") === "on";
    if (published && !hasContent(content)) refusal("Add something for fans before publishing.");
    const basedOn = String(formData.get("based_on") ?? "").slice(0, 40);
    const saved = await saveEventInfo(owner, content, published, basedOn);
    if (!saved.ok) {
      refusal(saved.reason === "stale" ? "Someone saved the event info after you opened it. Reload the page (copy your changes first) and save again." : "Could not save. Reload the page and try again.");
    }
    await audit({
      tournament_id: id,
      organization_id: owner.orgId,
      actor_role: staff.role,
      action: "EVENT_INFO_SAVED",
      entity_type: "tournament",
      entity_id: owner.tournamentId,
      old_value: saved.before ? { published: saved.before.published, updatedAt: saved.before.updatedAt } : null,
      new_value: { published, updatedAt: saved.after.updatedAt, eventGroupId: owner.eventGroupId },
    });
    revalidatePath(`/admin/tournaments/${id}/event-info`);
    return published ? "Saved and published. Fans see it in the app and on the event's Info page." : "Saved as a draft. Fans see nothing until you publish.";
  });
}

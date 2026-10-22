"use server";

import { revalidatePath } from "next/cache";
import { requireScopedPermission } from "@/lib/guard";
import { refusal, formResult, type FormState } from "@/lib/refusal";
import { removeStory, restoreStory } from "@/lib/stories/server";

/**
 * Restore or remove a Move Score story tied to one of the organisation's events
 * (admins). The organisation is resolved from the story itself; another
 * organisation's story, or one tied to no organisation, is "Not found".
 * Banning a poster is the platform admins' (Admin → Platform → Stories).
 */
export async function moderateOrgStoryAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return formResult(async () => {
    const storyId = String(formData.get("story_id") ?? "");
    const { staff } = await requireScopedPermission("moderate_stories", { story: storyId });
    const by = `${staff.orgName} (${staff.orgRole})`;
    const what = String(formData.get("do") ?? "");
    if (what === "restore") {
      if (!(await restoreStory(storyId, by))) refusal("That story was removed or is gone.");
      revalidatePath("/admin/org/stories");
      return "Restored: the story shows again until it expires.";
    }
    if (what === "remove") {
      if (!(await removeStory(storyId, by))) refusal("That story is already removed.");
      revalidatePath("/admin/org/stories");
      return "Removed for everyone.";
    }
    refusal("Pick Restore or Remove.");
  });
}

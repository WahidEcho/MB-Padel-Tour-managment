"use server";

import { revalidatePath } from "next/cache";
import { requirePlatformPermission } from "@/lib/guard";
import { refusal, formResult, type FormState } from "@/lib/refusal";
import { banPosterOf, liftBan, removeStory, restoreStory } from "@/lib/stories/server";

const PATH = "/admin/platform/stories";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Platform admins: restore, remove, or ban the poster of any Move Score story. */
export async function moderateStoryAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return formResult(async () => {
    const staff = await requirePlatformPermission();
    const by = `Move Score (${staff.orgRole})`;
    const storyId = String(formData.get("story_id") ?? "");
    if (!UUID.test(storyId)) refusal("No story was named.");
    const what = String(formData.get("do") ?? "");
    if (what === "restore") {
      if (!(await restoreStory(storyId, by))) refusal("That story was removed or is gone.");
      revalidatePath(PATH);
      return "Restored: the story shows again until it expires.";
    }
    if (what === "remove") {
      if (!(await removeStory(storyId, by))) refusal("That story is already removed.");
      revalidatePath(PATH);
      return "Removed for everyone.";
    }
    if (what === "ban") {
      const reason = String(formData.get("reason") ?? "").trim() || null;
      if (!(await banPosterOf(storyId, by, reason))) refusal("That story is gone.");
      revalidatePath(PATH);
      return "Banned: they can no longer post stories, and their live stories are removed.";
    }
    refusal("Pick Restore, Remove or Ban.");
  });
}

/** Lets a banned account post stories again. */
export async function liftStoryBanAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return formResult(async () => {
    const staff = await requirePlatformPermission();
    const userId = String(formData.get("user_id") ?? "");
    if (!UUID.test(userId)) refusal("No account was named.");
    if (!(await liftBan(userId, `Move Score (${staff.orgRole})`))) refusal("That account is not banned.");
    revalidatePath(PATH);
    return "Ban lifted.";
  });
}

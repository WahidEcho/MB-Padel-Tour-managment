import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/guard";
import { staffCan } from "@/lib/auth";
import { moderationQueue } from "@/lib/stories/server";
import { STORY_REPORTS_TO_HIDE } from "@/lib/stories/rules";
import ModerationList from "@/components/stories/ModerationList";
import { moderateOrgStoryAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Move Score Stories posted from the organisation's events that someone reported,
 * or that are hidden or removed. Admins restore or remove them; platform admins
 * also ban posters (Admin → Stories under the platform sections).
 */
export default async function OrgStoriesPage() {
  const staff = await requireStaff(["admin"], "/admin/org/stories");
  if (!staffCan(staff, "moderate_stories")) notFound();
  const rows = await moderationQueue(staff.orgId);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Stories</h1>
        <p className="text-sm text-muted">
          Fans post Move Score Stories from your events&apos; matches and passes in the app. A story is live at once and gone after
          24 hours. {STORY_REPORTS_TO_HIDE} reports from different accounts hide it until you restore or remove it here.
        </p>
      </div>
      <ModerationList rows={rows} act={moderateOrgStoryAction} canBan={false} />
    </div>
  );
}

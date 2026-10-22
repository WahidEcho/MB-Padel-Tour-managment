import StateForm from "@/components/StateForm";
import ModerationList from "@/components/stories/ModerationList";
import { requirePlatformPage } from "@/lib/guard";
import { moderationQueue, storyBans } from "@/lib/stories/server";
import { STORY_REPORTS_TO_HIDE } from "@/lib/stories/rules";
import { liftStoryBanAction, moderateStoryAction } from "./actions";

export const dynamic = "force-dynamic";

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Africa/Cairo", dateStyle: "medium", timeStyle: "short" });

/**
 * Move Score Stories across every organisation (platform admins): reported, hidden
 * and removed stories with Restore / Remove / Ban, and the banned accounts.
 * Organisations' admins see their own events' stories on Admin → Stories.
 */
export default async function PlatformStoriesPage() {
  await requirePlatformPage("/admin/platform/stories");
  const [rows, bans] = await Promise.all([moderationQueue(), storyBans()]);
  const waiting = rows.filter((r) => r.hiddenAt && !r.removedAt).length;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Stories</h1>
        <p className="text-sm text-muted">
          Every organisation&apos;s reported, hidden and removed Move Score Stories. A story is live at once and deleted 24 hours
          after posting; {STORY_REPORTS_TO_HIDE} reports from different accounts hide it until someone here restores or removes it.
          {waiting ? ` ${waiting} hidden ${waiting === 1 ? "story waits" : "stories wait"} for a decision.` : ""}
        </p>
      </div>
      <ModerationList rows={rows} act={moderateStoryAction} canBan />
      <section className="space-y-2">
        <h2 className="text-lg font-bold">Banned from posting</h2>
        {bans.length === 0 && <p className="text-sm text-muted">Nobody.</p>}
        {bans.map((b) => (
          <div key={b.userId} className="card flex flex-wrap items-center justify-between gap-2 text-sm" data-testid="story-ban">
            <div>
              <p className="font-semibold">{b.name ?? "Move Score fan"}</p>
              <p className="text-xs text-muted">
                {when(b.at)} by {b.bannedBy}
                {b.reason ? ` · ${b.reason}` : ""}
              </p>
            </div>
            <StateForm action={liftStoryBanAction} confirm="Let this account post stories again?">
              <input type="hidden" name="user_id" value={b.userId} />
              <button type="submit" className="btn-secondary">Lift ban</button>
            </StateForm>
          </div>
        ))}
      </section>
    </div>
  );
}

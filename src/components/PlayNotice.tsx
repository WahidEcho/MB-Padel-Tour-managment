import { db } from "@/lib/supabase";
import { noticeBanners, publicPlayStatus, resumeLine, type NoticeTone } from "@/lib/notices/playStatus";
import type { Tournament } from "@/lib/types";

const TONE: Record<NoticeTone, string> = {
  delayed: "border-warning/50 bg-warning/10 text-warning",
  suspended: "border-danger/50 bg-danger/10 text-danger",
  resumed: "border-success/50 bg-success/10 text-success",
  major: "border-accent/40 bg-accent/10 text-accent",
};
const EYEBROW: Record<NoticeTone, string> = { delayed: "Delay", suspended: "Suspended", resumed: "Resumed", major: "Announcement" };

/**
 * The public site's notices under the header: the organiser's play status (rain
 * delay, play suspended, resumed) and the latest major announcement. The same
 * rule as the app's banner (src/lib/notices/playStatus.ts). Server-rendered inside
 * the cached public layout, so it adds one small read per render, not per visitor.
 */
export default async function PlayNotice({ tournament }: { tournament: Pick<Tournament, "id" | "branding_config" | "timezone"> & { event_group_id?: string | null } }) {
  const filter = tournament.event_group_id ? `tournament_id.eq.${tournament.id},event_group_id.eq.${tournament.event_group_id}` : `tournament_id.eq.${tournament.id}`;
  const { data } = await db()
    .from("announcements")
    .select("id, title, body, level, published_at")
    .or(filter)
    .eq("level", "major")
    .lte("published_at", new Date().toISOString())
    .order("published_at", { ascending: false })
    .limit(1);
  const announcements = ((data ?? []) as { id: string; title: string; body: string | null; level: string; published_at: string }[]).map((a) => ({ ...a, publishedAt: a.published_at }));
  const banners = noticeBanners({ playStatus: publicPlayStatus(tournament.branding_config?.playStatus), announcements });
  if (!banners.length) return null;
  const tz = tournament.timezone || "Africa/Cairo";
  const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return (
    <div className="relative z-20 mx-auto w-full max-w-7xl space-y-2 px-4 pt-3" data-testid="play-notice">
      {banners.map((b) => (
        <div key={b.key} role="status" className={`rounded-xl border border-l-4 px-4 py-2 ${TONE[b.tone]}`} data-tone={b.tone}>
          <p className="text-[10px] font-bold uppercase tracking-widest">
            {EYEBROW[b.tone]} · {clock(b.at)}
          </p>
          <p className="font-bold text-foreground">{b.title}</p>
          {b.body && <p className="text-sm text-muted">{b.body}</p>}
          {b.resumeAt && <p className="text-sm text-muted">{resumeLine(clock(b.resumeAt))}</p>}
        </div>
      ))}
    </div>
  );
}

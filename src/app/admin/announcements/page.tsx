import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { announcementStats, listAnnouncements } from "@/lib/messaging/data";
import { AUDIENCE_LABEL } from "@/lib/messaging/audience";
import { transportMode } from "@/lib/messaging/transport";
import { AnnouncementStatus } from "./ui";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = { announcement: "Announcement", access_codes: "Access codes", new_tournament: "New tournament" };

export default async function AnnouncementsPage() {
  await requireRole(["admin", "manager"], "/admin/announcements");
  const list = await listAnnouncements(100);
  const stats = await announcementStats(list.map((a) => a.id));
  const dry = transportMode() === "dry-run";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Announcements</h1>
        <div className="flex flex-wrap gap-2">
          <Link href="/admin/announcements/new?preset=access_codes" className="btn-secondary">Send access codes</Link>
          <Link href="/admin/announcements/new?preset=new_tournament" className="btn-secondary">New tournament</Link>
          <Link href="/admin/announcements/new" className="btn-primary">New announcement</Link>
        </div>
      </div>
      <p className="text-xs text-muted">
        Email (Resend) and WhatsApp to players, tracked per person: who it reached, who read it, and who it did not reach and why.
      </p>
      {dry && (
        <p className="card border-warning/40 text-sm text-warning" data-testid="dry-run">
          Dry run: MESSAGING_DRY_RUN is on, so nothing actually leaves the server.
        </p>
      )}

      {list.length === 0 ? (
        <p className="card text-sm text-muted">Nothing sent yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-[20px] border border-border">
          <table className="w-full text-sm" data-testid="announcements">
            <thead className="bg-card text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2">Announcement</th>
                <th className="px-3 py-2">Audience</th>
                <th className="px-3 py-2 text-right">Sent</th>
                <th className="px-3 py-2 text-right">Delivered</th>
                <th className="px-3 py-2 text-right">Read</th>
                <th className="px-3 py-2 text-right">Failed</th>
                <th className="px-3 py-2 text-right">Not on WhatsApp</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {list.map((a) => {
                const s = stats.get(a.id)!.all;
                const wa = stats.get(a.id)!.whatsapp;
                return (
                  <tr key={a.id} className="border-t border-border">
                    <td className="px-3 py-2">
                      <Link href={`/admin/announcements/${a.id}`} className="font-semibold text-accent hover:underline">{a.title}</Link>
                      <p className="text-xs text-muted">
                        {KIND_LABEL[a.kind] ?? a.kind} · {a.channels.join(", ")} · {new Date(a.created_at).toLocaleString("en-GB", { timeZone: "Africa/Cairo", dateStyle: "medium", timeStyle: "short" })}
                      </p>
                    </td>
                    <td className="px-3 py-2 text-xs">{AUDIENCE_LABEL[a.audience.type] ?? a.audience.type}<br /><span className="text-muted">{a.recipients_total} deliveries</span></td>
                    <td className="px-3 py-2 text-right font-semibold">{s.sent}</td>
                    <td className="px-3 py-2 text-right text-success">{s.delivered}</td>
                    <td className="px-3 py-2 text-right text-success">{s.read}</td>
                    <td className="px-3 py-2 text-right text-danger">{s.failed - wa.notOnWhatsApp + s.bounced}{s.skipped ? <span className="text-xs text-warning"> +{s.skipped} not sent</span> : null}</td>
                    <td className="px-3 py-2 text-right text-danger">{wa.notOnWhatsApp}</td>
                    <td className="px-3 py-2"><AnnouncementStatus status={a.status} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

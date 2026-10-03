import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/guard";
import { AUDIENCE_LABEL } from "@/lib/messaging/audience";
import { FILTERS, announcementStats, getAnnouncement, listDeliveries, pushStats, type DeliveryFilter } from "@/lib/messaging/data";
import { maskPhone } from "@/lib/messaging/phone";
import { db } from "@/lib/supabase";
import ActionButton from "@/components/ActionButton";
import { cancelAction, retryFailedAction } from "../actions";
import { AnnouncementStatus, ChannelFunnel, StatusChip } from "../ui";
import Progress from "./Progress";

export const dynamic = "force-dynamic";
// The progress loop sends a chunk per call (pumpAction); give each call room.
export const maxDuration = 60;

const PAGE = 200;

export default async function AnnouncementDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ filter?: string; channel?: string; q?: string; page?: string; full?: string }>;
}) {
  const { id } = await params;
  await requireRole(["admin", "manager"], `/admin/announcements/${id}`);
  const a = await getAnnouncement(id);
  if (!a) notFound();
  const sp = await searchParams;
  const filter = (FILTERS.some((f) => f.key === sp.filter) ? sp.filter : "all") as DeliveryFilter;
  const channel = sp.channel === "email" || sp.channel === "whatsapp" ? sp.channel : "all";
  const page = Math.max(0, Number(sp.page) || 0);
  const showFull = sp.full === "1";

  const [stats, push, { rows, total }, tournament] = await Promise.all([
    announcementStats([id]).then((m) => m.get(id)!),
    pushStats(a.push_dedupe_key),
    listDeliveries(id, { filter, channel, q: sp.q, offset: page * PAGE, limit: PAGE }),
    a.tournament_id ? db().from("tournaments").select("name").eq("id", a.tournament_id).maybeSingle().then((r) => (r.data as { name: string } | null)?.name ?? null) : Promise.resolve(null),
  ]);
  // "Not on WhatsApp" is never retried: another try cannot reach a number without WhatsApp.
  const failedCount = stats.all.failed - stats.whatsapp.notOnWhatsApp;
  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { filter, channel, q: sp.q, full: sp.full, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v && !(k === "filter" && v === "all") && !(k === "channel" && v === "all")) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : "";
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <Link href="/admin/announcements" className="text-sm text-muted hover:text-foreground">← Announcements</Link>
          <h1 className="text-2xl font-bold">{a.title}</h1>
          <p className="text-xs text-muted">
            {AUDIENCE_LABEL[a.audience.type]}
            {tournament ? ` · ${tournament}` : ""}
            {a.audience.type === "nation" ? ` · ${a.audience.nationCode}` : ""} · {a.channels.join(", ")} · sent{" "}
            {a.sent_at ? new Date(a.sent_at).toLocaleString("en-GB", { timeZone: "Africa/Cairo", dateStyle: "medium", timeStyle: "short" }) : "—"}
            {a.created_by ? ` by ${a.created_by}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AnnouncementStatus status={a.status} />
          <a href={`/admin/announcements/${id}/export`} className="btn-secondary text-xs" data-testid="export">Export CSV</a>
          {failedCount > 0 && (
            <form action={retryFailedAction}>
              <input type="hidden" name="id" value={id} />
              <ActionButton className="btn-secondary text-xs" confirm={`Try the ${failedCount} failed message(s) again?`} pendingLabel="Queuing…">
                Retry failed ({failedCount})
              </ActionButton>
            </form>
          )}
          {a.status === "sending" && (
            <form action={cancelAction}>
              <input type="hidden" name="id" value={id} />
              <ActionButton className="btn-danger text-xs" confirm="Stop sending? Messages already sent stay sent." pendingLabel="Stopping…">
                Stop sending
              </ActionButton>
            </form>
          )}
        </div>
      </div>

      {a.status === "sending" && <Progress id={id} pending={stats.all.pending} />}

      <ChannelFunnel label="Email" s={stats.email} channel="email" />
      <ChannelFunnel label="WhatsApp" s={stats.whatsapp} channel="whatsapp" />
      {push && (
        <div className="card text-sm" data-testid="push-stats">
          <h2 className="label">App push</h2>
          <p>
            {push.devices} phones · <span className="text-success">{push.sent} sent</span> · <span className="text-danger">{push.failed} failed</span>
            {push.pending ? ` · ${push.pending} pending` : ""} <span className="text-xs text-muted">(outbox: {push.status})</span>
          </p>
        </div>
      )}

      <details className="card">
        <summary className="cursor-pointer text-sm font-semibold">Message</summary>
        <pre className="mt-2 whitespace-pre-wrap text-sm">{a.body}</pre>
        {a.whatsapp_template && (
          <p className="mt-2 text-xs text-muted">
            WhatsApp template: <b>{a.whatsapp_template.name}</b> ({a.whatsapp_template.language}) · variables:{" "}
            {a.whatsapp_template.params.map((p, i) => `{{${i + 1}}} = ${p.field === "custom" ? `“${p.text}”` : p.field}`).join(", ")}
          </p>
        )}
      </details>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-1" data-testid="filters">
          {FILTERS.map((f) => (
            <Link
              key={f.key}
              href={`/admin/announcements/${id}${qs({ filter: f.key, page: undefined })}`}
              className={`badge ${filter === f.key ? "bg-accent text-white" : "bg-border text-muted hover:text-foreground"}`}
              data-filter={f.key}
            >
              {f.label}
            </Link>
          ))}
          <span className="mx-2 text-border">|</span>
          {(["all", "email", "whatsapp"] as const).map((c) => (
            <Link key={c} href={`/admin/announcements/${id}${qs({ channel: c, page: undefined })}`} className={`badge ${channel === c ? "bg-foreground text-background" : "bg-border text-muted"}`}>
              {c === "all" ? "Both channels" : c === "email" ? "Email" : "WhatsApp"}
            </Link>
          ))}
          <form className="ml-auto flex gap-1" action={`/admin/announcements/${id}`}>
            {filter !== "all" && <input type="hidden" name="filter" value={filter} />}
            {channel !== "all" && <input type="hidden" name="channel" value={channel} />}
            <input name="q" defaultValue={sp.q ?? ""} className="input w-44 py-1 text-xs" placeholder="Search name" />
          </form>
        </div>

        <div className="overflow-x-auto rounded-[20px] border border-border">
          <table className="w-full text-sm" data-testid="deliveries">
            <thead className="bg-card text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2">Recipient</th>
                <th className="px-3 py-2">Channel</th>
                <th className="px-3 py-2">Address</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Reason</th>
                <th className="px-3 py-2">Last update</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border" data-status={r.status} data-channel={r.channel}>
                  <td className="px-3 py-2">{r.recipient_name || <span className="text-muted">(no name)</span>}</td>
                  <td className="px-3 py-2 text-xs">{r.channel === "email" ? "Email" : "WhatsApp"}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.channel === "whatsapp" && !showFull ? maskPhone(r.address) : r.address ?? "—"}</td>
                  <td className="px-3 py-2"><StatusChip status={r.status} channel={r.channel} errorCode={r.error_code} /></td>
                  <td className="px-3 py-2 text-xs text-muted">{r.error_reason ?? ""}{r.error_code && !/^[a-z_]+$/.test(r.error_code) ? ` (${r.error_code})` : ""}</td>
                  <td className="px-3 py-2 text-xs text-muted">{new Date(r.read_at ?? r.delivered_at ?? r.failed_at ?? r.sent_at ?? r.updated_at).toLocaleString("en-GB", { timeZone: "Africa/Cairo", dateStyle: "short", timeStyle: "short" })}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-sm text-muted">Nobody here.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between text-xs text-muted">
          <span>{total} row{total === 1 ? "" : "s"}{total > PAGE ? ` · page ${page + 1} of ${Math.ceil(total / PAGE)}` : ""}</span>
          <span className="flex gap-3">
            {page > 0 && <Link href={`/admin/announcements/${id}${qs({ page: String(page - 1) })}`}>← Previous</Link>}
            {(page + 1) * PAGE < total && <Link href={`/admin/announcements/${id}${qs({ page: String(page + 1) })}`}>Next →</Link>}
            <Link href={`/admin/announcements/${id}${qs({ full: showFull ? undefined : "1" })}`}>{showFull ? "Mask numbers" : "Show full numbers"}</Link>
          </span>
        </div>
      </div>
    </div>
  );
}

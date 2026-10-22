/* eslint-disable @next/next/no-img-element -- story pictures from the media bucket */
import StateForm from "@/components/StateForm";
import type { FormState } from "@/lib/refusal";
import type { ModerationRow } from "@/lib/stories/server";

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "Africa/Cairo", dateStyle: "medium", timeStyle: "short" }) : "—";

const REASONS: Record<string, string> = {
  spam: "Spam",
  nudity: "Nudity or sexual content",
  harassment: "Bullying or harassment",
  hate: "Hate speech",
  violence: "Violence or danger",
  false: "False information",
  other: "Something else",
};

function status(r: ModerationRow): { label: string; tone: string } {
  if (r.removedAt) return { label: `Removed${r.removedBy ? ` by ${r.removedBy}` : ""}`, tone: "bg-danger/15 text-danger" };
  if (r.hiddenAt) return { label: r.hiddenReason === "reports" ? "Hidden by reports" : "Hidden", tone: "bg-warning/15 text-warning" };
  if (Date.parse(r.expiresAt) <= Date.now()) return { label: "Expired", tone: "bg-muted/15 text-muted" };
  return { label: "Live", tone: "bg-success/15 text-success" };
}

/**
 * Reported, hidden and removed stories, the hidden ones first: what staff decide
 * on (App Store guideline 1.2: timely action on reports). `ban` only on the
 * platform page (a ban stops an account posting anywhere).
 */
export default function ModerationList({
  rows,
  act,
  canBan,
}: {
  rows: ModerationRow[];
  act: (prev: FormState, formData: FormData) => Promise<FormState>;
  canBan: boolean;
}) {
  if (!rows.length) return <p className="card p-6 text-center text-muted">No reported or hidden stories.</p>;
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid="story-moderation">
      {rows.map((r) => {
        const s = status(r);
        const reasons = Object.entries(
          r.reports.reduce<Record<string, number>>((m, x) => ({ ...m, [x.reason]: (m[x.reason] ?? 0) + 1 }), {}),
        );
        return (
          <section key={r.id} className="card flex gap-3" data-testid="story-row" data-story={r.id}>
            <div className="w-28 shrink-0">
              {r.imageUrl ? (
                <a href={r.imageUrl} target="_blank" rel="noreferrer">
                  <img src={r.imageUrl} alt="The story" className="aspect-[9/16] w-28 rounded-lg bg-black object-cover" />
                </a>
              ) : (
                <div className="flex aspect-[9/16] w-28 items-center justify-center rounded-lg bg-black/40 text-xs text-muted">Picture deleted</div>
              )}
            </div>
            <div className="min-w-0 flex-1 space-y-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`badge ${s.tone}`}>{s.label}</span>
                {r.banned && <span className="badge bg-danger/15 text-danger">Poster banned</span>}
              </div>
              <p className="font-semibold">{r.posterName ?? "Move Score fan"}</p>
              <p className="text-muted">{r.caption ?? r.tournamentName ?? ""}</p>
              <p className="text-xs text-muted">Posted {when(r.createdAt)} · expires {when(r.expiresAt)}</p>
              <p className="text-xs">
                <span className="font-semibold">{r.reports.length} report{r.reports.length === 1 ? "" : "s"}</span>
                {reasons.length ? `: ${reasons.map(([k, n]) => `${REASONS[k] ?? k}${n > 1 ? ` ×${n}` : ""}`).join(", ")}` : ""}
              </p>
              {!r.removedAt && (
                <div className="flex flex-wrap gap-2">
                  {r.hiddenAt && (
                    <StateForm action={act}>
                      <input type="hidden" name="story_id" value={r.id} />
                      <input type="hidden" name="do" value="restore" />
                      <button type="submit" className="btn-secondary">Restore</button>
                    </StateForm>
                  )}
                  <StateForm action={act} confirm="Remove this story for everyone? Its picture is deleted.">
                    <input type="hidden" name="story_id" value={r.id} />
                    <input type="hidden" name="do" value="remove" />
                    <button type="submit" className="btn-danger">Remove</button>
                  </StateForm>
                </div>
              )}
              {canBan && !r.banned && (
                <StateForm action={act} confirm="Ban this poster from posting stories? Their live stories are removed." className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="story_id" value={r.id} />
                  <input type="hidden" name="do" value="ban" />
                  <input name="reason" className="input w-48" placeholder="Reason (kept with the ban)" maxLength={300} />
                  <button type="submit" className="btn-danger">Ban poster</button>
                </StateForm>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

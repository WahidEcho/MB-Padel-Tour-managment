import { notFound } from "next/navigation";
import { requireTournamentPage } from "@/lib/guard";
import { staffCan } from "@/lib/auth";
import { isoToZonedInput } from "@/lib/tennis/ties";
import { STATUS_LABELS, moneyLabel, refundAllowed, refundAmount, REFUND_MESSAGES, type RegistrationStatus } from "@/lib/registration/rules";
import { eventById, eventRefusal, eventRegistrations, getSettings, onlinePaymentAvailable, startsAtOf, waitsForPairing } from "@/lib/registration/server";
import { siteUrl } from "@/lib/messaging/links";
import { db } from "@/lib/supabase";
import { decideRegistrationAction, markVenuePaidAction, pairRegistrationsAction, refundRegistrationAction, saveRegistrationSettings } from "./actions";

export const dynamic = "force-dynamic";

const ORDER: RegistrationStatus[] = ["pending_approval", "awaiting_payment", "confirmed", "refunded", "cancelled", "refused"];
const TONE: Record<RegistrationStatus, string> = {
  pending_approval: "bg-warning/15 text-warning",
  awaiting_payment: "bg-warning/15 text-warning",
  confirmed: "bg-success/15 text-success",
  refused: "bg-danger/10 text-danger",
  cancelled: "bg-border text-muted",
  refunded: "bg-border text-muted",
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Cairo" }) : "—");

/**
 * Registrations (Phase 9): settings for this event, and the entries — approve or
 * refuse, record a payment at the venue, pair individual players, refund an online
 * payment through Move Tick (admins with their own account, until 24 h before the
 * start). People's contact details are the ones they typed on their registration.
 */
export default async function RegistrationsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Re-checked on every request: the staff member's organisation must own this event.
  const { staff } = await requireTournamentPage(id, ["admin", "manager"], `/admin/tournaments/${id}/registrations`);
  const event = await eventById(id);
  if (!event) notFound();
  const refusal = eventRefusal(event);
  const settings = await getSettings(id);
  const { data: org } = await db().from("organizations").select("slug").eq("id", event.organization_id).maybeSingle();
  const online = onlinePaymentAvailable((org as { slug: string } | null)?.slug);
  const { data: session } = await db().from("friendly_sessions").select("starts_at").eq("tournament_id", id).maybeSingle();
  const startsAt = startsAtOf(event, (session as { starts_at: string | null } | null) ?? null);
  const refundWindow = refundAllowed(startsAt);
  const regs = await eventRegistrations(id);
  const mayRefund = staffCan(staff, "refund_registrations");
  const unpaired = regs.filter((r) => r.status === "confirmed" && !r.materialized_at && waitsForPairing(event, r.entry_type));
  const tz = event.timezone ?? "Africa/Cairo";

  return (
    <div className="space-y-4">
      <section className="card space-y-2">
        <h2 className="font-bold">Registration</h2>
        {refusal ? (
          <p className="text-sm text-muted">{refusal}</p>
        ) : (
          <p className="text-sm text-muted">
            Players register in the Move Score app or at{" "}
            <a className="underline" href={`/register/${event.slug}`} target="_blank">{`${siteUrl()}/register/${event.slug}`}</a>. Refunds are possible until 24 hours before the
            start time{startsAt ? ` (${when(new Date(Date.parse(startsAt) - 24 * 3600_000).toISOString())})` : ": set it in Settings first"}.
          </p>
        )}
        {!online && (
          <p className="rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
            Online payment (Move Tick) is available only for Move Beyond&apos;s events, once Move Tick is configured. Fees here are paid at the venue.
          </p>
        )}
      </section>

      {!refusal && (
        <form action={saveRegistrationSettings} className="card grid gap-3 sm:grid-cols-2">
          <input type="hidden" name="tournament_id" value={id} />
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" name="open" defaultChecked={settings.open} /> <span className="font-semibold">Taking registrations</span>
          </label>
          <label className="text-sm">
            <span className="label">Entry</span>
            <select name="entry_type" defaultValue={settings.entryType} className="input">
              <option value="team">Teams</option>
              <option value="individual">Individual players</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="label">Players per team</span>
            <input type="number" name="team_size" min={2} max={8} defaultValue={settings.teamSize < 2 ? 2 : settings.teamSize} className="input" />
          </label>
          <label className="text-sm">
            <span className="label">Approval</span>
            <select name="approval_mode" defaultValue={settings.approvalMode} className="input">
              <option value="organiser">The organiser approves each entry</option>
              <option value="automatic">Automatic</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="label">Fee per player (EGP, 0 = free)</span>
            <input name="fee" inputMode="decimal" defaultValue={settings.feeAmount ? String(settings.feeAmount / 100) : "0"} className="input" />
          </label>
          <label className="text-sm">
            <span className="label">Payment</span>
            <select name="payment" defaultValue={settings.payment} className="input">
              <option value="venue">At the venue</option>
              <option value="online" disabled={!online}>Online (Move Tick)</option>
              <option value="online_or_venue" disabled={!online}>Online or at the venue (player picks)</option>
              <option value="free">Free</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="label">Who pays for a team online</span>
            <select name="team_payer" defaultValue={settings.teamPayer} className="input">
              <option value="registrant">The registering player pays for everyone</option>
              <option value="each_player">Each player their share (partners pay at the venue)</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="label">Card fee kept on refunds (%) — Move Tick refunds in full only for now</span>
            <input type="number" name="refund_fee_percent" min={0} max={20} step="0.5" defaultValue={settings.refundFeePercent} className="input" />
          </label>
          <label className="text-sm">
            <span className="label">Most entries (empty = no limit)</span>
            <input type="number" name="capacity" min={1} max={2000} defaultValue={settings.capacity ?? ""} className="input" />
          </label>
          <label className="text-sm">
            <span className="label">Closes at ({tz})</span>
            <input type="datetime-local" name="closes_at" defaultValue={isoToZonedInput(settings.closesAt, tz)} className="input" />
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="label">Note for players</span>
            <textarea name="note" maxLength={1000} defaultValue={settings.note ?? ""} className="input" rows={2} />
          </label>
          <div className="sm:col-span-2">
            <button className="btn-primary">Save</button>
          </div>
        </form>
      )}

      {unpaired.length >= 2 && (
        <form action={pairRegistrationsAction} className="card space-y-2">
          <input type="hidden" name="tournament_id" value={id} />
          <h3 className="font-bold">Pair individual players into teams</h3>
          <div className="grid gap-1 sm:grid-cols-2">
            {unpaired.map((r) => (
              <label key={r.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="registration_ids" value={r.id} /> {r.people[0]?.name}
              </label>
            ))}
          </div>
          <button className="btn-secondary text-sm">Pair the two ticked</button>
        </form>
      )}

      <section className="space-y-3">
        {ORDER.map((status) => {
          const list = regs.filter((r) => r.status === status);
          if (!list.length) return null;
          return (
            <div key={status} className="card space-y-2">
              <h3 className="font-bold">
                {STATUS_LABELS[status]} <span className="text-muted">({list.length})</span>
              </h3>
              <ul className="divide-y divide-border">
                {list.map((r) => {
                  const paidOnline = r.payments.find((p) => p.method === "online" && (p.status === "paid" || p.status === "needs_review") && p.paid_at);
                  const pending = r.payments.find((p) => p.method === "online" && p.status === "refund_pending");
                  return (
                    <li key={r.id} className="space-y-1 py-2 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded px-2 py-0.5 text-xs font-semibold ${TONE[r.status]}`}>{STATUS_LABELS[r.status]}</span>
                        <span className="font-semibold">{r.team_name ?? r.people.map((p) => p.name).join(" / ")}</span>
                        <span className="text-xs text-muted">
                          {r.source === "app" ? "app" : r.source === "web" ? "web form" : "organiser"} · {when(r.created_at)}
                        </span>
                        {r.refund_requested_at && r.status === "confirmed" && <span className="rounded bg-warning/15 px-2 py-0.5 text-xs text-warning">refund asked</span>}
                        {r.payments.some((p) => p.status === "needs_review") && (
                          <span className="rounded bg-danger/10 px-2 py-0.5 text-xs text-danger">payment needs review</span>
                        )}
                      </div>
                      <ul className="text-xs text-muted">
                        {r.people.map((p, i) => (
                          <li key={i}>
                            {p.name}
                            {p.phone ? ` · ${p.phone}` : ""}
                            {p.email ? ` · ${p.email}` : ""}
                          </li>
                        ))}
                      </ul>
                      <p className="text-xs">
                        {r.payment_choice === "free"
                          ? "Free"
                          : [
                              r.amount_online ? `${moneyLabel(r.amount_online)} online${r.paid_at ? " — paid" : ""}${paidOnline?.status === "needs_review" ? " (review)" : ""}` : null,
                              r.amount_venue ? `${moneyLabel(r.amount_venue)} at the venue${r.venue_paid_at ? " — paid" : ""}` : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                        {r.payments.some((p) => p.test_mode) ? " · test mode" : ""}
                        {r.status === "confirmed" && !r.materialized_at && waitsForPairing(event, r.entry_type) ? " · not in a team yet" : ""}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {r.status === "pending_approval" && (
                          <>
                            <form action={decideRegistrationAction}>
                              <input type="hidden" name="registration_id" value={r.id} />
                              <button className="btn-primary text-xs" name="decision" value="approve">Approve</button>
                            </form>
                            <form action={decideRegistrationAction} className="flex gap-1">
                              <input type="hidden" name="registration_id" value={r.id} />
                              <input name="note" placeholder="reason (optional)" maxLength={500} className="input py-1 text-xs" />
                              <button className="btn-secondary text-xs" name="decision" value="refuse">Refuse</button>
                            </form>
                          </>
                        )}
                        {r.status === "awaiting_payment" && !r.paid_at && (
                          <form action={decideRegistrationAction}>
                            <input type="hidden" name="registration_id" value={r.id} />
                            <button className="btn-secondary text-xs" name="decision" value="refuse">Refuse</button>
                          </form>
                        )}
                        {r.status === "confirmed" && r.amount_venue > 0 && !r.venue_paid_at && (
                          <form action={markVenuePaidAction}>
                            <input type="hidden" name="registration_id" value={r.id} />
                            <button className="btn-secondary text-xs">Paid at the venue ({moneyLabel(r.amount_venue)})</button>
                          </form>
                        )}
                        {paidOnline && !pending && r.status !== "refunded" && mayRefund && (
                          <form action={refundRegistrationAction} className="flex flex-wrap gap-1">
                            <input type="hidden" name="registration_id" value={r.id} />
                            <input name="reason" placeholder="reason" maxLength={200} className="input py-1 text-xs" />
                            <input name="confirm" placeholder="type REFUND" maxLength={10} className="input w-28 py-1 text-xs" />
                            <button className="btn-secondary text-xs" disabled={!refundWindow.ok && paidOnline.status !== "needs_review"}>
                              Refund {moneyLabel(refundAmount(paidOnline.amount, settings.refundFeePercent))}
                            </button>
                            {!refundWindow.ok && paidOnline.status !== "needs_review" && <span className="text-xs text-muted">{REFUND_MESSAGES[refundWindow.reason]}</span>}
                          </form>
                        )}
                        {pending && <span className="text-xs text-muted">Refund on its way from Move Tick.</span>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
        {regs.length === 0 && <p className="text-sm text-muted">No registrations yet.</p>}
      </section>
    </div>
  );
}

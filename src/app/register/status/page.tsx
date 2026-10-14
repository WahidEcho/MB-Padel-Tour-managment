import type { Metadata } from "next";
import { HELD_FULL_MESSAGE, moneyLabel } from "@/lib/registration/rules";
import { statusView } from "@/lib/registration/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Registration · Move Score", robots: { index: false } };

const ERRORS: Record<string, string> = {
  full: "Sorry: this event is full. Every place is taken.",
  full_held: HELD_FULL_MESSAGE,
  too_many_checkouts: "Too many payment attempts for this entry today. Try again tomorrow, or ask the organiser.",
  conflict: "This entry changed meanwhile. Try again.",
  checkout_open: "A checkout for this entry is still open. Try again in a few minutes.",
  move_tick: "Online payment is not reachable right now. Try again in a moment.",
  not_due: "Nothing is due online for this entry.",
  unavailable: "Online payment is not available for this event.",
};

/**
 * Where Move Tick sends a payer back, the link the web form shows and the link in
 * every email: the event and the registration's status, nothing personal, and a
 * Pay button while an entry is due online (a web guest's way to pay). Only
 * a link signed for this registration opens it; any other gets the same "not found".
 */
export default async function RegistrationStatus({ searchParams }: { searchParams: Promise<{ r?: string; s?: string; e?: string; confirmed?: string }> }) {
  const { r, s, e, confirmed } = await searchParams;
  const view = r ? await statusView(r, s ?? null) : null;
  return (
    <main className="mx-auto w-full max-w-md space-y-4 p-4 text-center">
      {view ? (
        <div className="card space-y-2">
          <p className="text-xs font-bold uppercase tracking-widest text-accent">{view.event.organization?.name ?? "Move Score"}</p>
          <h1 className="text-xl font-bold">{view.event.name}</h1>
          {confirmed && <p className="text-sm text-success">Thanks: your email address is confirmed.</p>}
          <p className="font-semibold">{view.label}</p>
          {e && <p className="text-sm text-danger">{ERRORS[e] ?? "Something went wrong. Try again."}</p>}
          {view.paymentFailed && !e && (
            <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm font-semibold text-danger" data-testid="payment-failed">
              {view.paymentFailed}
            </p>
          )}
          <p className="text-sm text-muted" data-testid="status-note">
            {view.status === "awaiting_payment"
              ? `${view.placeNote ?? ""} If you just paid, this page updates within a minute.`
              : view.status === "confirmed"
                ? "You're in. The confirmation is on its way."
                : view.status === "unconfirmed"
                  ? "Open the link we emailed you to confirm your registration."
                  : view.status === "pending_approval"
                    ? `The organiser confirms each entry; we'll email you when they do.${view.amountOnline > 0 ? " Once approved, your place is kept for 24 hours while you pay." : ""}`
                    : "Questions? Ask the organiser."}
          </p>
          {view.paymentLines.length > 0 && (
            <ul className="text-sm" data-testid="payment-lines">
              {view.paymentLines.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          )}
          {view.canPay && (
            <form method="post" action="/api/register/pay">
              <input type="hidden" name="r" value={r} />
              <input type="hidden" name="s" value={s} />
              <button className="btn-primary w-full">Pay {moneyLabel(view.amountOnline)}</button>
            </form>
          )}
          <p className="text-xs text-muted">Using the Move Score app? You can close this page: your entry is under My profile → Registrations.</p>
        </div>
      ) : (
        <div className="card">
          <p className="font-bold">Registration not found</p>
        </div>
      )}
    </main>
  );
}

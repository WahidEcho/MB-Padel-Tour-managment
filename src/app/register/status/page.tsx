import type { Metadata } from "next";
import { moneyLabel } from "@/lib/registration/rules";
import { statusView } from "@/lib/registration/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Registration · Move Score", robots: { index: false } };

const ERRORS: Record<string, string> = {
  full: "Sorry: the place kept for this entry ran out and the event is now full.",
  checkout_open: "A checkout for this entry is still open. Try again in a few minutes.",
  move_tick: "Online payment is not reachable right now. Try again in a moment.",
  not_due: "Nothing is due online for this entry.",
  unavailable: "Online payment is not available for this event.",
};

/**
 * Where Move Tick sends a payer back, the link the web form shows and the link in
 * every email: the event and the registration's status, nothing personal, and a
 * Pay button once an approved entry is due online (a web guest's way to pay). Only
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
          <p className="text-sm text-muted">
            {view.status === "awaiting_payment"
              ? "Approved. Pay to confirm your place; if you just paid, this page updates within a minute."
              : view.status === "confirmed"
                ? "You're in. The confirmation is on its way."
                : view.status === "unconfirmed"
                  ? "Open the link we emailed you to confirm your registration."
                  : view.status === "pending_approval"
                    ? "The organiser confirms each entry; we'll email you when they do."
                    : "Questions? Ask the organiser."}
          </p>
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

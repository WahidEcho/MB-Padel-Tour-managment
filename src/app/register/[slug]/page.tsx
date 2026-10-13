import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { registrationInfo } from "@/lib/registration/server";
import { moneyLabel } from "@/lib/registration/rules";
import RegisterForm from "./RegisterForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Register · Move Score", robots: { index: false } };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Cairo" }) : "Start time to be confirmed";

/**
 * Public registration for a tournament or a friendly session (Phase 9). Shows
 * public facts only (the event, the fee, how to pay, the refund deadline); the
 * form posts to /api/register/{slug}. Players with the Move Score app register
 * there instead, and their entry is linked to their account.
 */
export default async function RegisterPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const info = await registrationInfo(slug);
  if (!info) notFound();
  const paid = info.feePerPlayer > 0;
  return (
    <main className="mx-auto w-full max-w-md space-y-4 p-4">
      <header className="space-y-1 text-center">
        <p className="text-xs font-bold uppercase tracking-widest text-accent">{info.event.organization?.name ?? "Move Score"}</p>
        <h1 className="text-2xl font-bold">{info.event.name}</h1>
        <p className="text-sm text-muted">{when(info.event.startsAt)}</p>
      </header>

      <section className="card space-y-1 text-sm">
        <p>
          <span className="font-semibold">Entry:</span> {info.entryType === "team" ? `teams of ${info.people}` : "individual players"}
        </p>
        <p>
          <span className="font-semibold">Fee:</span> {paid ? info.feeLabel : "free"}
          {paid && info.entryType === "team" ? (info.teamPayer === "registrant" ? " (you pay for the whole team)" : " (each player pays their own share)") : ""}
        </p>
        {paid && (
          <p>
            <span className="font-semibold">Payment:</span>{" "}
            {info.paymentOptions.includes("online") && info.paymentOptions.includes("venue")
              ? "online through Move Tick, or at the venue"
              : info.paymentOptions.includes("online")
                ? "online through Move Tick"
                : "at the venue"}
          </p>
        )}
        <p>
          <span className="font-semibold">Approval:</span> {info.approval === "organiser" ? "the organiser confirms each entry (you pay only after that)" : "automatic"}
        </p>
        {paid && (
          <p className="text-muted">
            {info.refundsUntil
              ? `Refunds until ${when(info.refundsUntil)} (24 hours before the start)${info.refundFeePercent > 0 ? `, less a ${info.refundFeePercent}% card fee` : ""}.`
              : "Refunds until 24 hours before the start."}
          </p>
        )}
        {info.note && <p className="whitespace-pre-line text-muted">{info.note}</p>}
      </section>

      {info.open ? (
        <RegisterForm
          slug={slug}
          people={info.people}
          entryType={info.entryType}
          options={info.paymentOptions}
          partnerPhoneRequired={info.event.kind === "session"}
          totalLabel={paid ? moneyLabel(info.feePerPlayer * info.people) : null}
        />
      ) : (
        <div className="card space-y-2 text-center">
          <p className="font-bold">{info.closedMessage}</p>
          <p className="text-sm text-muted">Speak to the organiser if you&apos;d like to take part.</p>
        </div>
      )}
      <p className="text-center text-xs text-muted">
        Have the Move Score app? Register there: your entry appears in your account. By registering you share the names and contact
        details you enter with the organiser. <a className="underline" href="/movescore/privacy">Privacy</a>
      </p>
    </main>
  );
}

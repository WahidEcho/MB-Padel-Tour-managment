import type { Metadata } from "next";
import { statusView } from "@/lib/registration/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Registration · Move Score", robots: { index: false } };

/**
 * Where Move Tick sends a payer back (and the link the web form shows): the
 * event and the registration's status, nothing personal. Only a link signed for
 * this registration opens it; any other gets the same "not found".
 */
export default async function RegistrationStatus({ searchParams }: { searchParams: Promise<{ r?: string; s?: string }> }) {
  const { r, s } = await searchParams;
  const view = r ? await statusView(r, s ?? null) : null;
  return (
    <main className="mx-auto w-full max-w-md space-y-4 p-4 text-center">
      {view ? (
        <div className="card space-y-2">
          <p className="text-xs font-bold uppercase tracking-widest text-accent">{view.event.organization?.name ?? "Move Score"}</p>
          <h1 className="text-xl font-bold">{view.event.name}</h1>
          <p className="font-semibold">{view.label}</p>
          <p className="text-sm text-muted">
            {view.status === "awaiting_payment"
              ? "We haven't heard from Move Tick yet. If you just paid, this page updates within a minute."
              : view.status === "confirmed"
                ? "You're in. The confirmation is on its way."
                : "Questions? Ask the organiser."}
          </p>
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

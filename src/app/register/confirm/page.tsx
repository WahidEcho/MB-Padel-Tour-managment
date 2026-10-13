import type { Metadata } from "next";
import { confirmToken, eventById } from "@/lib/registration/server";
import { safeEqual } from "@/lib/auth/safeEqual";
import { db } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Confirm your registration · Move Score", robots: { index: false } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASONS: Record<string, string> = {
  expired: "This link has expired: register again.",
  already_registered: "This email address is already registered for this event.",
  full: "Sorry: this event is full.",
  closed: "This registration was cancelled: register again.",
  deadline: "Registration for this event has closed.",
  finished: "This event has finished.",
  conflict: "Could not confirm right now. Try again.",
  not_found: "This link is not valid.",
};

/**
 * Where the link emailed to a web guest opens: the event's name and one button.
 * Opening the page changes nothing (mail scanners fetch links); the button's POST
 * (/api/register/confirm) confirms. Only a link signed for this registration shows
 * the button; any other gets the same "not valid".
 */
export default async function ConfirmRegistration({ searchParams }: { searchParams: Promise<{ r?: string; c?: string; e?: string }> }) {
  const { r, c, e } = await searchParams;
  const valid = Boolean(r && c && UUID.test(r) && safeEqual(c, confirmToken(r)));
  let eventName: string | null = null;
  if (valid) {
    const { data } = await db().from("registrations").select("tournament_id").eq("id", r!).maybeSingle();
    const event = data ? await eventById((data as { tournament_id: string }).tournament_id) : null;
    eventName = event?.name ?? null;
  }
  return (
    <main className="mx-auto w-full max-w-md space-y-4 p-4 text-center">
      {valid && eventName ? (
        <div className="card space-y-3">
          <h1 className="text-xl font-bold">{eventName}</h1>
          {e ? <p className="text-sm text-danger">{REASONS[e] ?? REASONS.conflict}</p> : <p className="text-sm text-muted">Confirm that you registered with this email address.</p>}
          <form method="post" action="/api/register/confirm">
            <input type="hidden" name="r" value={r} />
            <input type="hidden" name="c" value={c} />
            <button className="btn-primary w-full">Confirm my registration</button>
          </form>
          <p className="text-xs text-muted">Didn&apos;t register? Close this page: nothing happens unless you confirm.</p>
        </div>
      ) : (
        <div className="card">
          <p className="font-bold">{REASONS.not_found}</p>
        </div>
      )}
    </main>
  );
}

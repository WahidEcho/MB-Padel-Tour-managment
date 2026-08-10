import { notFound } from "next/navigation";
import { getSessionBySlug } from "@/lib/friendly/data";
import RegisterClient from "./RegisterClient";

export const dynamic = "force-dynamic";

export default async function RegisterPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await getSessionBySlug(slug);
  if (!session) notFound();

  const deadlinePassed =
    session.registration_deadline !== null &&
    new Date(session.registration_deadline) < new Date();
  const open = session.status === "open" && !deadlinePassed;

  return (
    <main className="mx-auto w-full max-w-md space-y-4 p-4">
      <header className="space-y-1 text-center">
        <p className="text-xs font-bold uppercase tracking-widest text-accent">Move Beyond</p>
        <h1 className="text-2xl font-bold">{session.name}</h1>
        <p className="text-sm text-muted">
          {session.starts_at
            ? new Date(session.starts_at).toLocaleString(undefined, {
                weekday: "long",
                day: "numeric",
                month: "long",
                hour: "2-digit",
                minute: "2-digit",
              })
            : "Date to be confirmed"}
          {" · "}
          {session.duration_minutes} min
        </p>
      </header>

      {open ? (
        <RegisterClient slug={slug} />
      ) : (
        <div className="card space-y-2 text-center">
          <p className="text-3xl">🔒</p>
          <p className="font-bold">Registration is closed</p>
          <p className="text-sm text-muted">
            {deadlinePassed
              ? "The registration deadline for this session has passed."
              : "This session isn't taking registrations right now."}
          </p>
          <p className="text-sm text-muted">Speak to an organiser if you&apos;d like to join.</p>
        </div>
      )}
    </main>
  );
}

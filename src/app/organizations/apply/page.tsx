import type { Metadata } from "next";
import ApplyForm from "./ApplyForm";

export const metadata: Metadata = { title: "Run your events on Move Score" };

/** Public: a club, academy or organiser applies; Move Beyond approves (Admin → Organisations). */
export default async function ApplyPage({ searchParams }: { searchParams: Promise<{ via?: string }> }) {
  const { via } = await searchParams;
  return (
    <main className="mx-auto w-full max-w-xl flex-1 space-y-4 p-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-accent">Move Score</p>
        <h1 className="text-2xl font-bold">Run your events on Move Score</h1>
        <p className="mt-1 text-sm text-muted">
          Clubs, academies and organisers run their tournaments, sessions and players on Move Score, scored live on court and
          followed in the app. Tell us about yours: Move Beyond reviews every application.
        </p>
      </div>
      <ApplyForm via={via === "app" ? "app" : "web"} />
    </main>
  );
}

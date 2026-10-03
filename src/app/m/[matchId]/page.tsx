import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * Where a match check-in code lands for someone whose phone opened it in the
 * browser rather than the app. The app handles this link itself when installed.
 */
export default async function MatchCheckinLanding({ params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(matchId)) notFound();
  const { data: m } = await db().from("matches").select("tournament_id").eq("id", matchId).maybeSingle();
  if (!m) notFound();
  const { data: t } = await db().from("tournaments").select("name, slug, public_access_enabled").eq("id", (m as { tournament_id: string }).tournament_id).maybeSingle();
  const tournament = t as { name: string; slug: string; public_access_enabled: boolean | null } | null;
  if (!tournament?.public_access_enabled) notFound();
  return (
    <main className="theme-dark flex min-h-screen flex-col items-center justify-center gap-5 bg-background p-6 text-center text-foreground">
      <p className="text-xs uppercase tracking-[0.3em] text-muted">Move Score</p>
      <h1 className="text-3xl font-black">You&apos;re at the match</h1>
      <p className="max-w-sm text-muted">
        Get the Move Score app and scan this code again to check in: every match you attend adds to the score on your event pass.
      </p>
      <Link href={`/t/${tournament.slug}`} className="btn-primary">Follow {tournament.name} here</Link>
    </main>
  );
}

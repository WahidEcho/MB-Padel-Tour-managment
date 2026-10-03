import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { db } from "@/lib/supabase";
import { nationOptions } from "@/lib/messaging/audience";
import { whatsappTemplates } from "@/lib/messaging/data";
import { PRESETS, type AnnouncementKindInput } from "@/lib/messaging/compose";
import { transportMode } from "@/lib/messaging/transport";
import Composer from "./Composer";

export const dynamic = "force-dynamic";
// "Send" resolves the audience and queues every row; the first chunk goes out right after.
export const maxDuration = 60;

export default async function NewAnnouncementPage({ searchParams }: { searchParams: Promise<{ preset?: string; tournament?: string }> }) {
  await requireRole(["admin", "manager"], "/admin/announcements/new");
  const sp = await searchParams;
  const kind: AnnouncementKindInput = sp.preset === "access_codes" || sp.preset === "new_tournament" ? sp.preset : "announcement";

  const [{ data: tRows }, nations, wa] = await Promise.all([
    db().from("tournaments").select("id, name, slug, status, starts_on").eq("kind", "tournament").order("created_at", { ascending: false }).limit(200),
    nationOptions(),
    whatsappTemplates(),
  ]);
  const tournaments = (tRows ?? []) as { id: string; name: string; slug: string; status: string; starts_on: string | null }[];
  const preT = tournaments.find((t) => t.id === sp.tournament) ?? null;

  const preset = kind === "announcement" ? null : PRESETS[kind];
  const initial = {
    kind,
    title: preset ? preset.title(preT?.name ?? "{tournament}") : "",
    body: preset ? preset.body(preT?.name ?? "{tournament}") : "",
    cta: preset?.cta ?? null,
    tournamentId: preT?.id ?? null,
    // Codes go to the players who have them; a new tournament goes to everyone.
    audience: kind === "access_codes" && preT ? { type: "tournament" as const, tournamentId: preT.id } : { type: "all_players" as const },
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">
          {kind === "access_codes" ? "Send each player their access code" : kind === "new_tournament" ? "Announce a new tournament" : "New announcement"}
        </h1>
        <Link href="/admin/announcements" className="text-sm text-muted hover:text-foreground">← All announcements</Link>
      </div>
      {transportMode() === "dry-run" && (
        <p className="card border-warning/40 text-sm text-warning">Dry run: nothing actually leaves the server (MESSAGING_DRY_RUN).</p>
      )}
      <Composer initial={initial} tournaments={tournaments} nations={nations} templates={wa.templates} templatesError={wa.error} />
    </div>
  );
}

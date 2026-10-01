import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * Where the venue QR code lands for someone whose phone opened it in the browser
 * rather than the app. The app itself handles this link directly when installed.
 */
export default async function VenueLanding({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { data } = await db().from("event_groups").select("id, name, city").eq("slug", slug).maybeSingle();
  const group = data as { id: string; name: string; city: string | null } | null;
  if (!group) notFound();
  const { data: ts } = await db().from("tournaments").select("name, slug").eq("event_group_id", group.id).eq("public_access_enabled", true);
  return (
    <main className="theme-dark flex min-h-screen flex-col items-center justify-center gap-5 bg-background p-6 text-center text-foreground">
      <p className="text-xs uppercase tracking-[0.3em] text-muted">Move Score</p>
      <h1 className="text-3xl font-black">You&apos;re at {group.name}</h1>
      <p className="max-w-sm text-muted">
        Get the Move Score app and scan this code again to stamp your event pass. Or follow the scores here in the browser:
      </p>
      <div className="flex flex-col gap-2">
        {((ts ?? []) as { name: string; slug: string }[]).map((t) => (
          <Link key={t.slug} href={`/t/${t.slug}`} className="btn-primary">{t.name}</Link>
        ))}
      </div>
    </main>
  );
}

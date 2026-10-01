import { notFound } from "next/navigation";
import { headers } from "next/headers";
import QRCode from "qrcode";
import { db } from "@/lib/supabase";
import { requireRole } from "@/lib/guard";
import AutoRefresh from "@/components/AutoRefresh";
import { WINDOW_SECONDS, dailyCode, eventDay, rotatingCode, venueUrl } from "@/lib/pass/venueCode";

export const dynamic = "force-dynamic";

/**
 * The gate tablet: a QR code that changes every 45 seconds. Fans scan it in the
 * Move Score app to unlock the on-site edition of their pass and stamp the day.
 * The daily six-digit code is for staff to read out when scanning is awkward.
 */
export default async function VenueQrPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  await requireRole(["admin", "manager", "operator"], `/venue/${slug}/qr`);
  const { data } = await db().from("event_groups").select("slug, name, timezone").eq("slug", slug).maybeSingle();
  const group = data as { slug: string; name: string; timezone: string } | null;
  if (!group) notFound();
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
  const code = rotatingCode(group.slug);
  const svg = await QRCode.toString(venueUrl(origin, group.slug, code), { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#05060a", light: "#ffffff" } });
  const day = eventDay(group.timezone);
  return (
    <main className="theme-dark flex min-h-screen flex-col items-center justify-center gap-6 bg-background p-6 text-center text-foreground">
      <AutoRefresh seconds={Math.max(10, Math.floor(WINDOW_SECONDS / 3))} />
      <p className="text-sm uppercase tracking-[0.3em] text-muted">{group.name}</p>
      <h1 className="text-4xl font-black">Scan for your on-site pass</h1>
      <div className="w-[min(80vw,520px)] rounded-3xl bg-white p-5" dangerouslySetInnerHTML={{ __html: svg }} />
      <p className="text-lg">Open Move Score → My pass → Scan the venue code</p>
      <p className="text-sm text-muted">
        Changes every {WINDOW_SECONDS} seconds · Staff code for {day}: <span className="font-mono text-2xl font-bold text-foreground">{dailyCode(group.slug, day)}</span>
      </p>
    </main>
  );
}

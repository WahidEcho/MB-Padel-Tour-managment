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
 *
 * The screen faces the crowd, so it never shows the daily six-digit code (a photo
 * of it would work all day, anywhere). Staff open the same page with ?staff=1 on
 * their own signed-in phone to read the code out when scanning is awkward.
 */
export default async function VenueQrPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ staff?: string }> }) {
  const { slug } = await params;
  const { staff } = await searchParams;
  await requireRole(["admin", "manager", "operator"], `/venue/${slug}/qr`);
  const { data } = await db().from("event_groups").select("slug, name, timezone").eq("slug", slug).maybeSingle();
  const group = data as { slug: string; name: string; timezone: string | null } | null;
  if (!group) notFound();
  const showStaffCode = staff === "1"; // the guard above already demands a staff session
  if (showStaffCode) {
    const day = eventDay(group.timezone || "Africa/Cairo");
    return (
      <main className="theme-dark flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6 text-center text-foreground">
        <p className="text-sm uppercase tracking-[0.3em] text-muted">{group.name} · staff only</p>
        <h1 className="text-2xl font-black">Today&apos;s venue code</h1>
        <p className="font-mono text-6xl font-bold">{dailyCode(group.slug, day)}</p>
        <p className="text-sm text-muted">For {day}. Read it out to a fan who can&apos;t scan the gate screen; don&apos;t post or display it.</p>
      </main>
    );
  }
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
  const code = rotatingCode(group.slug);
  const svg = await QRCode.toString(venueUrl(origin, group.slug, code), { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#05060a", light: "#ffffff" } });
  return (
    <main className="theme-dark flex min-h-screen flex-col items-center justify-center gap-6 bg-background p-6 text-center text-foreground">
      <AutoRefresh seconds={Math.max(10, Math.floor(WINDOW_SECONDS / 3))} />
      <p className="text-sm uppercase tracking-[0.3em] text-muted">{group.name}</p>
      <h1 className="text-4xl font-black">Scan for your on-site pass</h1>
      <div className="w-[min(80vw,520px)] rounded-3xl bg-white p-5" dangerouslySetInnerHTML={{ __html: svg }} />
      <p className="text-lg">Open Move Score → My pass → Scan the venue code</p>
      <p className="text-sm text-muted">Changes every {WINDOW_SECONDS} seconds · Can&apos;t scan? Ask a member of staff for today&apos;s code.</p>
    </main>
  );
}

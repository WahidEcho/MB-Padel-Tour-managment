import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { requireStaff, requireTournamentPage } from "@/lib/guard";
import { can } from "@/lib/auth";
import { formatEventCode, openEventCode } from "@/lib/orgs/codes";
import { codeWorks, courtCodeEvent, courtCodesOf, eventCourts } from "@/lib/orgs/courtCodes";
import { courtKey, courtLink } from "@/lib/orgs/courtScope";
import { siteUrl } from "@/lib/messaging/links";
import PrintButton from "../match/[matchId]/PrintButton";

export const dynamic = "force-dynamic";

/**
 * The court QR sheet: one A4 page per court with a working court code (migration
 * 0034): a big QR of `https://tour.mbeg.org/r#<code>`, the court, the event, the
 * code in text, and how referees use and hand it over. Organisers only; never cached.
 */
export default async function CourtQrSheet({ searchParams }: { searchParams: Promise<{ event?: string }> }) {
  const { event } = await searchParams;
  const staff = await requireStaff(["admin", "manager"], "/admin/org/codes/courts");
  if (!can(staff.role, "manage_codes") || !event) notFound();
  // The event's own organisation decides (another organisation's: 404).
  await requireTournamentPage(event, ["admin", "manager"], `/qr/courts?event=${event}`);
  const ev = await courtCodeEvent(staff.orgId, event);
  if (!ev) notFound();
  const [courts, codes] = await Promise.all([eventCourts(ev), courtCodesOf(staff.orgId, ev)]);
  const site = siteUrl();
  const pages = [];
  for (const court of courts) {
    const row = codes.find((c) => codeWorks(c) && courtKey(c.court_name) === court.key);
    const code = row ? openEventCode(row.code_sealed) : null;
    if (!row || !code) continue;
    const shown = formatEventCode(code);
    const url = courtLink(site, shown);
    const svg = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#05060a", light: "#ffffff" } });
    pages.push({ court: court.name, shown, svg, expires: row.expires_at });
  }

  return (
    <main className="court-sheet bg-white text-black">
      <style>{`
        @page { size: A4 portrait; margin: 12mm; }
        .court-sheet { min-height: 100vh; }
        .court-page { width: 186mm; min-height: 270mm; margin: 0 auto 12mm; padding: 10mm 8mm; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 5mm; border: 1px dashed #d4d4d4; }
        .court-page svg { width: 120mm; height: 120mm; }
        @media print {
          .court-page { border: none; margin: 0 auto; break-after: page; page-break-after: always; }
          .court-page:last-child { break-after: auto; page-break-after: auto; }
          .no-print { display: none !important; }
        }
      `}</style>
      <div className="no-print flex items-center justify-between gap-3 p-4">
        <p className="text-sm text-neutral-600">{pages.length} {pages.length === 1 ? "page" : "pages"} · {ev.title}. Print on A4; one page per court.</p>
        <PrintButton />
      </div>
      {pages.length === 0 && <p className="p-8 text-center text-neutral-600">No working court codes. Create them on Admin → Event codes → Court codes.</p>}
      {pages.map((p) => (
        <section key={p.court} className="court-page" data-testid="court-sheet-page">
          <p className="text-sm uppercase tracking-[0.3em] text-neutral-500">{ev.title}</p>
          <h1 className="text-6xl font-black">{p.court}</h1>
          <p className="text-xl font-semibold">Referee scoring</p>
          <div dangerouslySetInnerHTML={{ __html: p.svg }} />
          <p className="font-mono text-3xl font-bold tracking-widest" data-testid="court-sheet-code">{p.shown}</p>
          <ol className="max-w-[150mm] list-decimal space-y-1 pl-6 text-left text-base">
            <li>Scan this code with the phone camera: Move Score opens the referee console on {p.court}. (No app yet? The page that opens has the download links.)</li>
            <li>Already in Move Score: Referee → Scan court QR.</li>
            <li>No camera? In Move Score → Referee, type the code above.</li>
            <li>Changing referees: the referee leaving taps Sign out; the new referee scans this code on their own phone.</li>
            <li>Moving to another court: scan that court&apos;s code. A match you have not finished or sent stays yours until it is.</li>
            <li>You see only this court&apos;s matches today. Keep this sheet at the referee table; if it goes missing, tell the tournament desk.</li>
          </ol>
          <p className="text-xs text-neutral-500">{p.expires ? `Works until ${new Date(p.expires).toLocaleString("en-GB", { timeZone: "Africa/Cairo", dateStyle: "medium", timeStyle: "short" })}` : "Works for the whole event"} · Move Score</p>
        </section>
      ))}
    </main>
  );
}

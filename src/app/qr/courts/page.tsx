import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { requireStaff, requireTournamentPage } from "@/lib/guard";
import { can } from "@/lib/auth";
import { formatEventCode, openEventCode } from "@/lib/orgs/codes";
import { codeWorks, courtCodeEvent, courtCodesOf, eventCourts } from "@/lib/orgs/courtCodes";
import { courtKey, courtLink } from "@/lib/orgs/courtScope";
import { siteUrl } from "@/lib/messaging/links";
import PrintButton from "../match/[matchId]/PrintButton";
import { loadEventBrand } from "@/lib/brand/server";
import { BrandBand, BrandFoot, BrandTitle } from "@/components/brand/PrintBrand";

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
  const brand = await loadEventBrand(ev.tournamentId);
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
        .court-page { width: 186mm; height: 270mm; margin: 0 auto 12mm; display: flex; flex-direction: column; border: 1px dashed #d4d4d4; box-sizing: border-box; overflow: hidden; }
        .court-body { flex: 1; min-height: 0; overflow: hidden; padding: 4mm 8mm 2mm; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 3mm; }
        .court-foot { padding: 0 8mm 4mm; }
        .court-page svg { width: 86mm; height: 86mm; }
        @media print {
          .court-page { border: none; margin: 0 auto; }
          .court-wrap { break-after: page; page-break-after: always; }
          .court-wrap:last-of-type { break-after: auto; page-break-after: auto; }
          .no-print { display: none !important; }
        }
      `}</style>
      <div className="no-print flex items-center justify-between gap-3 p-4">
        <p className="text-sm text-neutral-600">{pages.length} {pages.length === 1 ? "page" : "pages"} · {ev.title}. Print on A4; one page per court.</p>
        <PrintButton />
      </div>
      {pages.length === 0 && <p className="p-8 text-center text-neutral-600">No working court codes. Create them on Admin → Event codes → Court codes.</p>}
      {pages.map((p) => (
        <div key={p.court} className="court-wrap">
        <p className="no-print mx-auto mb-1 flex w-[186mm] justify-end text-xs">
          <a href={`/qr/courts/share?event=${event}&court=${encodeURIComponent(p.court)}`} download className="text-blue-700 underline" data-testid="court-share">Share image (PNG)</a>
        </p>
        <section className="court-page" data-testid="court-sheet-page">
          <BrandBand brand={brand} label="Chair umpire scoring" />
          <BrandTitle brand={brand} />
          <div className="court-body">
          <h1 className="text-5xl font-black">{p.court}</h1>
          <p className="text-xl font-semibold">Chair umpire scoring</p>
          <div dangerouslySetInnerHTML={{ __html: p.svg }} />
          <p className="font-mono text-2xl font-bold tracking-widest" data-testid="court-sheet-code">{p.shown}</p>
          <ol className="max-w-[160mm] list-decimal space-y-0.5 pl-6 text-left text-[13px] leading-snug">
            <li>Scan this code with the phone camera: Move Score opens the chair umpire&apos;s console on {p.court}, then asks you to type <strong>your own 4-digit referee PIN</strong>. (No app yet? The page that opens has the download links.)</li>
            <li>Already in Move Score: Referee → Scan court QR, then your PIN.</li>
            <li>No camera? In Move Score → Referee, type the code above, then your PIN.</li>
            <li data-testid="legacy-pin-note"><strong>Move Score 1.0.1:</strong> type the court code, then your 4-digit PIN, in the one field: <span className="font-mono">{p.shown} ••••</span> (a space, then your PIN).</li>
            <li>Changing chair umpires: the chair umpire leaving taps Sign out; the new chair umpire scans this code on their own phone, picks their own name and types their own PIN. The PIN is personal: never share it. Five wrong PINs lock only that chair umpire for 5 minutes; the phone they signed in on today still gets back in.</li>
            <li>Need help on court? Tap <strong>Call for assistance</strong> on the scoring screen: the master referees are alerted.</li>
            <li>Moving to another court: scan that court&apos;s code. A match you have not finished or sent stays yours until it is.</li>
            <li>You see only this court&apos;s matches today. Keep this sheet at the umpire&apos;s chair; if it goes missing, tell the tournament desk.</li>
          </ol>
          <p className="text-xs text-neutral-500">{p.expires ? `Works until ${new Date(p.expires).toLocaleString("en-GB", { timeZone: "Africa/Cairo", dateStyle: "medium", timeStyle: "short" })}` : "Works for the whole event"}</p>
          </div>
          <div className="court-foot">
            <BrandFoot brand={brand} />
          </div>
        </section>
        </div>
      ))}
    </main>
  );
}

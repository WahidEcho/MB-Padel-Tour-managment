/* eslint-disable @next/next/no-img-element -- local flag SVGs on a print sheet */
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { requireStaff, requireTournamentPage } from "@/lib/guard";
import { staffCan } from "@/lib/auth";
import { formatEventCode, openEventCode } from "@/lib/orgs/codes";
import { courtCodeEvent } from "@/lib/orgs/courtCodes";
import { coachCodeWorks, coachCodesOf, coachEventTeams } from "@/lib/coaches/server";
import { coachLink } from "@/lib/coaches/rules";
import { nationByCode } from "@/lib/tennis/nations";
import { siteUrl } from "@/lib/messaging/links";
import PrintButton from "../match/[matchId]/PrintButton";

export const dynamic = "force-dynamic";

/**
 * Team coach cards (migration 0037): one card per team with a working coach code, two to
 * an A4 page: the team, its event, a QR of `https://tour.mbeg.org/c#<code>` (opens Move
 * Score; without the app, a page with the download links), the code in text and how the
 * coaches use it. `team` prints one team's card. Admins only; never cached.
 */
export default async function CoachCards({ searchParams }: { searchParams: Promise<{ event?: string; team?: string }> }) {
  const { event, team } = await searchParams;
  const staff = await requireStaff(["admin"], "/admin/org/coaches");
  if (!staffCan(staff, "manage_coaches") || !event) notFound();
  // The event's own organisation decides (another organisation's: 404).
  await requireTournamentPage(event, ["admin"], `/qr/coaches?event=${event}`);
  const ev = await courtCodeEvent(staff.orgId, event);
  if (!ev) notFound();
  const [teams, codes] = await Promise.all([coachEventTeams(ev), coachCodesOf(staff.orgId, ev)]);
  const site = siteUrl();
  const eventName = new Map(ev.tournaments.map((t) => [t.id, t.name]));
  const cards = [];
  for (const t of teams) {
    if (team && t.id !== team) continue;
    const row = codes.find((c) => c.team_id === t.id && coachCodeWorks(c));
    const code = row ? openEventCode(row.code_sealed) : null;
    if (!row || !code) continue;
    const shown = formatEventCode(code);
    const svg = await QRCode.toString(coachLink(site, shown), { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#05060a", light: "#ffffff" } });
    cards.push({ id: t.id, team: t.team_name, nation: t.nation_code, iso2: t.iso2 ?? nationByCode(t.nation_code)?.iso2 ?? null, event: eventName.get(t.tournament_id) ?? ev.title, shown, svg, expires: row.expires_at });
  }
  const host = site.replace(/^https?:\/\//, "").replace(/\/+$/, "");

  return (
    <main className="coach-sheet bg-white text-black">
      <style>{`
        @page { size: A4 portrait; margin: 10mm; }
        .coach-sheet { min-height: 100vh; }
        .coach-card { width: 190mm; height: 134mm; margin: 0 auto 6mm; padding: 7mm 8mm; display: grid; grid-template-columns: 62mm 1fr; gap: 7mm; border: 1.5px solid #05060a; border-radius: 5mm; box-sizing: border-box; overflow: hidden; }
        .coach-card svg { width: 62mm; height: 62mm; }
        .coach-card ol { counter-reset: none; }
        @media print {
          .coach-card { margin: 0 auto 6mm; break-inside: avoid; page-break-inside: avoid; }
          .coach-card:nth-of-type(2n) { break-after: page; page-break-after: always; }
          .no-print { display: none !important; }
        }
      `}</style>
      <div className="no-print flex items-center justify-between gap-3 p-4">
        <p className="text-sm text-neutral-600">{cards.length} {cards.length === 1 ? "card" : "cards"} · {ev.title}. Print on A4, two cards to a page; cut along the border.</p>
        <PrintButton />
      </div>
      {cards.length === 0 && <p className="p-8 text-center text-neutral-600">No working coach codes. Create them on Admin → Team coaches.</p>}
      {cards.map((c) => (
        <section key={c.id} className="coach-card" data-testid="coach-card">
          <div className="flex flex-col items-center justify-between text-center">
            <div dangerouslySetInnerHTML={{ __html: c.svg }} />
            <div>
              <p className="text-[10px] uppercase tracking-[0.25em] text-neutral-500">Team code</p>
              <p className="font-mono text-xl font-bold tracking-widest" data-testid="coach-card-code">{c.shown}</p>
            </div>
            <p className="text-[10px] text-neutral-500">{c.expires ? `Works until ${new Date(c.expires).toLocaleString("en-GB", { timeZone: "Africa/Cairo", dateStyle: "medium", timeStyle: "short" })}` : "Works for the whole event"}</p>
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <p className="text-[11px] uppercase tracking-[0.25em] text-neutral-500">{c.event} · Move Score</p>
            <div className="flex items-center gap-3">
              {c.iso2 && <img src={`/flags/${c.iso2}.svg`} alt="" className="h-9 w-12 rounded-sm border border-neutral-300 object-cover" />}
              <h1 className="truncate text-3xl font-black leading-tight" data-testid="coach-card-team">{c.team}</h1>
            </div>
            <p className="text-base font-semibold">Team coach access{c.nation ? ` · ${c.nation}` : ""}</p>
            <ol className="list-decimal space-y-1 pl-5 text-[12.5px] leading-snug">
              <li>Scan the QR code with your phone camera: Move Score opens on <strong>My team</strong>. (No app yet? The page that opens has the download links.)</li>
              <li>Already in Move Score: Account → Staff → <strong>Coach sign-in</strong>, then type the code.</li>
              <li>On a computer: open <strong>{host}/coach</strong> and type the code.</li>
              <li>The head coach and every assistant use this same code, each on their own phone. Alerts reach every phone signed in: tie soon, called to court, started, result, line-up entered.</li>
              <li>You see your own team only: your group table, your ties with court and time, your line-ups once the referee enters them, live scores and match logs of your rubbers, and where you play after the groups.</li>
              <li>Line-ups are given to the referee as usual; the app cannot change them, score or call the referee.</li>
              <li>Keep this card within your team staff. Lost it? Ask the tournament desk for a new code (the old one stops at once).</li>
            </ol>
          </div>
        </section>
      ))}
    </main>
  );
}

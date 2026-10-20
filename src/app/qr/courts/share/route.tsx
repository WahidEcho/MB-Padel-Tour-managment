import { staffRoute } from "@/lib/guard";
import { formatEventCode, openEventCode } from "@/lib/orgs/codes";
import { codeWorks, courtCodeEvent, courtCodesOf, eventCourts } from "@/lib/orgs/courtCodes";
import { courtKey, courtLink } from "@/lib/orgs/courtScope";
import { siteUrl } from "@/lib/messaging/links";
import { loadEventBrand } from "@/lib/brand/server";
import { fileSlug } from "@/lib/brand/brand";
import { shareCardResponse } from "@/lib/brand/shareCard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "private, no-store" } });

/**
 * A court's referee QR card as a branded PNG (1080×1350) to share: `?event=<tournament>&court=<court name>`.
 * Organisers only (manage_codes), the event's own organisation; never cached.
 */
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const event = q.get("event") ?? "";
  const court = q.get("court") ?? "";
  // The event's own organisation decides (another organisation's: the same 404 as a missing one).
  const gate = await staffRoute("manage_codes", { tournament: event });
  if (!gate.ok) return gate.response;
  const ev = await courtCodeEvent(gate.staff.orgId, event);
  if (!ev) return notFound();
  const [courts, codes] = await Promise.all([eventCourts(ev), courtCodesOf(gate.staff.orgId, ev)]);
  const c = courts.find((x) => x.key === courtKey(court));
  const row = c ? codes.find((x) => codeWorks(x) && courtKey(x.court_name) === c.key) : undefined;
  const plain = row ? openEventCode(row.code_sealed) : null;
  if (!c || !row || !plain) return notFound();
  const shown = formatEventCode(plain);
  const brand = await loadEventBrand(ev.tournamentId);
  return shareCardResponse({
    brand,
    kind: "Referee scoring",
    heading: c.name,
    subheading: "Court code for the referees",
    link: courtLink(siteUrl(), shown),
    code: shown,
    steps: [
      `Scan the QR with the phone camera: Move Score opens the referee console on ${c.name}.`,
      "Then type your own 4-digit referee PIN. The PIN is personal: never share it.",
      "Changing referees: sign out; the next referee scans this code on their own phone.",
    ],
    validity: row.expires_at ? `Works until ${new Date(row.expires_at).toLocaleString("en-GB", { timeZone: "Africa/Cairo", dateStyle: "medium", timeStyle: "short" })} (Cairo)` : "Works for the whole event",
    fileName: `court-card-${fileSlug(c.name, 20)}-${fileSlug(brand.eventName, 30)}.png`,
  });
}

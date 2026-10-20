import { staffRoute } from "@/lib/guard";
import { formatEventCode, openEventCode } from "@/lib/orgs/codes";
import { courtCodeEvent } from "@/lib/orgs/courtCodes";
import { coachCodeWorks, coachCodesOf, coachEventTeams } from "@/lib/coaches/server";
import { coachLink } from "@/lib/coaches/rules";
import { nationByCode } from "@/lib/tennis/nations";
import { siteUrl } from "@/lib/messaging/links";
import { loadEventBrand } from "@/lib/brand/server";
import { fileSlug } from "@/lib/brand/brand";
import { shareCardResponse } from "@/lib/brand/shareCard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "private, no-store" } });

/**
 * A team's coach card as a branded PNG (1080×1350) to share (WhatsApp): `?event=<tournament>&team=<team>`.
 * Admins only (manage_coaches), the event's own organisation; never cached. The image carries the
 * team's working code, like the printed card.
 */
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const event = q.get("event") ?? "";
  const team = q.get("team") ?? "";
  // The event's own organisation decides (another organisation's: the same 404 as a missing one).
  const gate = await staffRoute("manage_coaches", { tournament: event });
  if (!gate.ok) return gate.response;
  const ev = await courtCodeEvent(gate.staff.orgId, event);
  if (!ev) return notFound();
  const [teams, codes] = await Promise.all([coachEventTeams(ev), coachCodesOf(gate.staff.orgId, ev)]);
  const t = teams.find((x) => x.id === team);
  const row = t ? codes.find((c) => c.team_id === t.id && coachCodeWorks(c)) : undefined;
  const plain = row ? openEventCode(row.code_sealed) : null;
  if (!t || !row || !plain) return notFound();
  const shown = formatEventCode(plain);
  const site = siteUrl();
  const host = site.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const brand = await loadEventBrand(t.tournament_id);
  const eventName = ev.tournaments.find((x) => x.id === t.tournament_id)?.name ?? ev.title;
  if (!brand.subtitle && eventName !== brand.eventName) brand.subtitle = eventName;
  return shareCardResponse({
    brand,
    kind: "Team coach",
    heading: t.team_name,
    iso2: t.iso2 ?? nationByCode(t.nation_code)?.iso2 ?? null,
    subheading: `Team coach access${t.nation_code ? ` · ${t.nation_code}` : ""}`,
    link: coachLink(site, shown),
    code: shown,
    steps: [
      "Scan the QR with your phone camera: Move Score opens on My team.",
      `In the app: Account → Staff → Coach sign-in. On a computer: ${host}/coach.`,
      "Head coach and assistants use this same code, each on their own phone. Keep it within your team staff.",
    ],
    validity: row.expires_at ? `Works until ${new Date(row.expires_at).toLocaleString("en-GB", { timeZone: "Africa/Cairo", dateStyle: "medium", timeStyle: "short" })} (Cairo)` : "Works for the whole event",
    fileName: `coach-card-${fileSlug(t.team_name, 30)}-${fileSlug(eventName, 30)}.png`,
  });
}

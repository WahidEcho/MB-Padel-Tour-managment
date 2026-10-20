import { notFound } from "next/navigation";
import { headers } from "next/headers";
import QRCode from "qrcode";
import { db } from "@/lib/supabase";
import { requireEntityPage } from "@/lib/guard";
import { RUBBER_LABELS } from "@/lib/tennis/ties";
import type { RubberType } from "@/lib/types";
import { matchCheckinUrl, matchPrintedCode } from "@/lib/pass/venueCode";
import PrintButton from "./PrintButton";
import { loadEventBrand } from "@/lib/brand/server";
import { BrandBand, BrandFoot, BrandTitle } from "@/components/brand/PrintBrand";

export const dynamic = "force-dynamic";

/**
 * The printable check-in code for one match, to stand at the court. Unlike the
 * court TV's code it never changes, so it only works while the match's check-in
 * is open (from shortly before it starts until a while after it ends).
 */
export default async function PrintedMatchQr({ params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  // The match's own tournament decides the organisation.
  await requireEntityPage({ match: matchId }, ["admin", "manager", "operator"], `/qr/match/${matchId}`);
  if (!/^[0-9a-f-]{36}$/i.test(matchId)) notFound();
  const { data } = await db().from("matches").select("id, tournament_id, rubber_type, round_name, team_a_id, team_b_id, court_id").eq("id", matchId).maybeSingle();
  const m = data as { id: string; tournament_id: string; rubber_type: RubberType | null; round_name: string | null; team_a_id: string | null; team_b_id: string | null; court_id: string | null } | null;
  if (!m) notFound();
  const ids = [m.team_a_id, m.team_b_id].filter(Boolean) as string[];
  const [brand, { data: teams }, { data: court }] = await Promise.all([
    loadEventBrand(m.tournament_id),
    ids.length ? db().from("teams").select("id, team_name").in("id", ids) : Promise.resolve({ data: [] }),
    m.court_id ? db().from("courts").select("court_name").eq("id", m.court_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const name = new Map(((teams ?? []) as { id: string; team_name: string }[]).map((x) => [x.id, x.team_name]));
  const sides = `${(m.team_a_id && name.get(m.team_a_id)) || "To be decided"} v ${(m.team_b_id && name.get(m.team_b_id)) || "To be decided"}`;
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
  const svg = await QRCode.toString(matchCheckinUrl(origin, m.id, { p: matchPrintedCode(m.id) }), { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#05060a", light: "#ffffff" } });
  return (
    <main className="flex min-h-screen flex-col bg-white text-center text-black">
      <BrandBand brand={brand} label="Match check-in" />
      <BrandTitle brand={brand} />
      <div className="flex flex-1 flex-col items-center justify-center gap-5 p-8">
      <h1 className="text-4xl font-black">{sides}</h1>
      <p className="text-lg text-neutral-600">{[m.rubber_type ? RUBBER_LABELS[m.rubber_type] : m.round_name, (court as { court_name: string } | null)?.court_name].filter(Boolean).join(" · ")}</p>
      <div className="w-[min(80vw,420px)]" dangerouslySetInnerHTML={{ __html: svg }} />
      <p className="text-2xl font-bold">Scan in Move Score to check in to this match</p>
      <p className="text-sm text-neutral-500">Move Score → My pass → Scan · Opens shortly before the match starts</p>
      <PrintButton />
      </div>
      <div className="px-8 pb-6">
        <BrandFoot brand={brand} />
      </div>
    </main>
  );
}

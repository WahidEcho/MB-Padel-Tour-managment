/**
 * An organisation's public page in the app. Only approved organisations, only
 * the public columns (PUBLIC_ORG_COLUMNS), and only its tournaments the app may
 * show anyway (public, of kind "tournament", active or completed, and not demos
 * unless placed in an event group), its public leagues and its top board (names
 * and points only): never member emails, codes, the application, the plan or
 * billing, or whether it opted out of the platform board.
 */
import { db } from "../supabase";
import type { MOrgProfile, MTournamentCard } from "./contract";
import { memo } from "./http";
import { toCard, type TournamentRow } from "./projection";
import { CARD_COLUMNS } from "./server";
import { PUBLIC_ORG_COLUMNS, toPublicOrg, type OrgRowPublicPart } from "../orgs/profile";
import { isOrgSlug } from "../orgs/roles";

export async function getOrgProfile(slug: string, boardMonth?: string): Promise<MOrgProfile | null> {
  if (!isOrgSlug(slug)) return null;
  // Whether it is public is read every time (one small row): a suspended or
  // not-yet-approved organisation is never served from this instance's memo.
  const { data: gate } = await db().from("organizations").select("id, status, updated_at").eq("slug", slug).maybeSingle();
  const g = gate as { id: string; status: string; updated_at: string } | null;
  if (!g || g.status !== "approved") return null;
  const month = boardMonth && /^\d{4}-(0[1-9]|1[0-2])$/.test(boardMonth) ? boardMonth : undefined;
  return memo(`org:${g.id}:${g.updated_at}:${month ?? "now"}`, 15_000, async () => {
    const { data } = await db().from("organizations").select(PUBLIC_ORG_COLUMNS).eq("id", g.id).maybeSingle();
    const org = data as (OrgRowPublicPart & { id: string; status: string }) | null;
    if (!org || org.status !== "approved") return null;
    const { data: rows } = await db()
      .from("tournaments")
      .select(CARD_COLUMNS)
      .eq("organization_id", org.id)
      .eq("kind", "tournament")
      .eq("public_access_enabled", true)
      .in("status", ["active", "completed"])
      .or("is_demo.eq.false,event_group_id.not.is.null")
      .order("created_at", { ascending: false })
      .limit(60);
    const list = (rows ?? []) as unknown as TournamentRow[];
    const ids = list.map((t) => t.id);
    const live = new Map<string, number>();
    const teams = new Map<string, number>();
    if (ids.length) {
      const [m, tm] = await Promise.all([
        db().from("matches").select("tournament_id").in("tournament_id", ids).in("status", ["live", "paused"]),
        db().from("teams").select("tournament_id").in("tournament_id", ids),
      ]);
      for (const r of (m.data ?? []) as { tournament_id: string }[]) live.set(r.tournament_id, (live.get(r.tournament_id) ?? 0) + 1);
      for (const r of (tm.data ?? []) as { tournament_id: string }[]) teams.set(r.tournament_id, (teams.get(r.tournament_id) ?? 0) + 1);
    }
    const branding = { id: org.id, slug: org.slug, name: org.name, colors: org.colors, logo_url: org.logo_url };
    const cards = list.map((t) => toCard(t, live.get(t.id) ?? 0, teams.get(t.id) ?? 0, branding));
    const today = new Date().toISOString().slice(0, 10);
    const isPast = (c: MTournamentCard) => c.status === "completed" || (c.endsOn !== null && c.endsOn < today);
    // Leagues and the organisation's top board (Phase 7): names and numbers only.
    const { leagueCards, topBoard } = await import("../leagues/server");
    const orgRef = { slug: org.slug, name: org.name };
    const leagues = await leagueCards({ organizationId: org.id }, new Map([[org.id, orgRef]]));
    const top = await topBoard({ organizationId: org.id }, month);
    const { count: counting } = await db()
      .from("leagues")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", org.id)
      .in("status", ["active", "closed"])
      .eq("counts_toward_top_of_all", true);
    return {
      generatedAt: new Date().toISOString(),
      organization: toPublicOrg(org),
      tournaments: {
        live: cards.filter((c) => c.liveCount > 0),
        upcoming: cards.filter((c) => c.liveCount === 0 && !isPast(c)),
        past: cards.filter((c) => c.liveCount === 0 && isPast(c)),
      },
      leagues,
      topBoard: (counting ?? 0) > 0 ? top : null,
      comingSoon: [],
    };
  });
}

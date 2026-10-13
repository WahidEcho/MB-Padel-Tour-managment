import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { ownerOf } from "@/lib/mobile/identity";
import { privateJson } from "@/lib/mobile/http";
import { toScore } from "@/lib/mobile/projection";
import { widgetItems, type WidgetSource } from "@/lib/mobile/widget";
import type { MWidget } from "@/lib/mobile/contract";
import type { Match, MatchSnapshot } from "@/lib/types";

/** Matches looked at, at most (a player in a long event, plus starred ones). */
const MAX_MATCHES = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The tournaments among `ids` whose matches anyone may follow in the app: public
 * (public_access_enabled), not a draft, of an approved organisation; a friendly
 * session's hidden tournament only as a public league's night or season
 * (isPublicLeagueSession). Everything else is left out.
 */
async function publicTournaments(ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!ids.length) return out;
  const { data } = await db().from("tournaments").select("id, kind, status, public_access_enabled, organization_id").in("id", ids);
  const rows = (data ?? []) as { id: string; kind: string; status: string; public_access_enabled: boolean; organization_id: string | null }[];
  const orgIds = [...new Set(rows.map((t) => t.organization_id).filter((x): x is string => Boolean(x)))];
  const { data: orgs } = orgIds.length ? await db().from("organizations").select("id, status").in("id", orgIds) : { data: [] };
  const approved = new Set(((orgs ?? []) as { id: string; status: string }[]).filter((o) => o.status === "approved").map((o) => o.id));
  const { isPublicLeagueSession } = await import("@/lib/leagues/server");
  for (const t of rows) {
    if (!t.public_access_enabled || t.status === "draft" || !t.organization_id || !approved.has(t.organization_id)) continue;
    if (t.kind === "tournament" || (t.kind === "friendly_session" && (await isPublicLeagueSession(t.id)))) out.add(t.id);
  }
  return out;
}

/**
 * The My matches widget: the signed-in person's own matches (through their
 * claimed player codes, the same rule as GET /me/matches) and the matches this
 * phone or account starred that the app may show (publicTournaments), as ready-to-show rows. Team names and court names
 * only; nothing private about players.
 */
export async function GET(request: Request) {
  const { owner } = await ownerOf(request);
  if (!owner) return NextResponse.json({ error: "Register this phone first" }, { status: 401 });

  const mineIds = new Set<string>();
  const matches = new Map<string, Match>();

  if (owner.kind === "user") {
    // Two plain reads: player_claims references players twice (player_id, via_player_id), so an embed is ambiguous.
    // Archived links (an event that ended over a day ago, Phase 9) no longer fill the widget.
    const { data: claims } = await db().from("player_claims").select("player_id").eq("user_id", owner.id).is("archived_at", null);
    const claimed = ((claims ?? []) as { player_id: string }[]).map((c) => c.player_id);
    const { data: rows } = claimed.length ? await db().from("players").select("id, team_id").in("id", claimed) : { data: [] };
    const players = ((rows ?? []) as { id: string; team_id: string | null }[]).filter((p): p is { id: string; team_id: string } => Boolean(p.team_id));
    const teamIds = [...new Set(players.map((p) => p.team_id))];
    if (teamIds.length) {
      const { data: ms } = await db()
        .from("matches")
        .select("*")
        .or(teamIds.map((t) => `team_a_id.eq.${t},team_b_id.eq.${t}`).join(","))
        .limit(MAX_MATCHES);
      const ids = new Set(players.map((p) => p.id));
      for (const m of (ms ?? []) as Match[]) {
        const nominees = [...(m.team_a_player_ids ?? []), ...(m.team_b_player_ids ?? [])];
        if (m.tie_id && nominees.length && !nominees.some((n) => ids.has(n))) continue;
        matches.set(m.id, m);
        mineIds.add(m.id);
      }
    }
  }

  const { data: stars } = await db().from("follows").select("target_key").eq("owner_kind", owner.kind).eq("owner_id", owner.id).eq("target_kind", "match").limit(MAX_MATCHES);
  const starred = ((stars ?? []) as { target_key: string }[]).map((s) => s.target_key).filter((id) => UUID.test(id) && !matches.has(id));
  if (starred.length) {
    const { data: ms } = await db().from("matches").select("*").in("id", starred);
    // A starred match shows only while the app could show it anyway: a public event
    // of an approved organisation (a draft, a hidden session or a suspended
    // organisation's event drops out). The account's own matches always show.
    const shown = await publicTournaments([...new Set(((ms ?? []) as Match[]).map((m) => m.tournament_id))]);
    for (const m of (ms ?? []) as Match[]) if (shown.has(m.tournament_id)) matches.set(m.id, m);
  }

  const all = [...matches.values()];
  const teamIds = [...new Set(all.flatMap((m) => [m.team_a_id, m.team_b_id]).filter((x): x is string => Boolean(x)))];
  const courtIds = [...new Set(all.map((m) => m.court_id).filter((x): x is string => Boolean(x)))];
  const liveIds = all.filter((m) => ["live", "paused", "completed", "walkover", "retired"].includes(m.status)).map((m) => m.id);
  const [{ data: teams }, { data: courts }, { data: snaps }] = await Promise.all([
    teamIds.length ? db().from("teams").select("id, team_name, nation_code").in("id", teamIds) : Promise.resolve({ data: [] }),
    courtIds.length ? db().from("courts").select("id, court_name").in("id", courtIds) : Promise.resolve({ data: [] }),
    liveIds.length ? db().from("match_score_snapshots").select("*").in("match_id", liveIds) : Promise.resolve({ data: [] }),
  ]);
  const teamLabel = new Map(((teams ?? []) as { id: string; team_name: string; nation_code: string | null }[]).map((t) => [t.id, t.nation_code ?? t.team_name]));
  const courtName = new Map(((courts ?? []) as { id: string; court_name: string }[]).map((c) => [c.id, c.court_name]));
  const snapOf = new Map(((snaps ?? []) as MatchSnapshot[]).map((s) => [s.match_id, s]));

  const sources: WidgetSource[] = all.map((m) => ({
    id: m.id,
    status: m.status,
    scheduledTime: m.scheduled_time,
    endedAt: m.ended_at ?? null,
    a: (m.team_a_id && teamLabel.get(m.team_a_id)) || "",
    b: (m.team_b_id && teamLabel.get(m.team_b_id)) || "",
    court: (m.court_id && courtName.get(m.court_id)) || "",
    score: toScore(m, snapOf.get(m.id) ?? null),
    mine: mineIds.has(m.id),
  }));
  const now = Date.now();
  const body: MWidget = { items: widgetItems(sources, now), signedIn: owner.kind === "user", updatedAt: now };
  return privateJson(body);
}

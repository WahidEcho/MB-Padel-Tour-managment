/**
 * Session export for prize-giving and record keeping.
 *
 * CSV rather than the tournament's ExcelJS workbook: a session is one flat
 * table of players, and CSV opens on any phone at the venue.
 * Admin-only — this is the one place a session's full detail is exposed.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { currentRole } from "@/lib/auth";
import { can } from "@/lib/auth";
import { getRankingSnapshot, getSessionBySlug, listPublicPlayers } from "@/lib/friendly/data";

export const dynamic = "force-dynamic";

function csvCell(value: unknown): string {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const role = await currentRole();
  if (!can(role, "export")) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }

  const { slug } = await ctx.params;
  const session = await getSessionBySlug(slug);
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const rows = await getRankingSnapshot("session", session.id);
  const names = await listPublicPlayers(rows.map((r) => r.player_profile_id));

  const { data: matches } = await db()
    .from("matches")
    .select("id, round_name, status")
    .eq("tournament_id", session.tournament_id)
    .eq("stage", "friendly")
    .order("match_order");

  const header = [
    "Rank",
    "Player",
    "Points",
    "Base points",
    "Fire points",
    "Matches played",
    "Wins",
    "Losses",
    "Games won",
    "Games lost",
    "Game diff",
    "Active streak",
  ];

  const lines = [
    `Session,${csvCell(session.name)}`,
    `Status,${csvCell(session.status)}`,
    `Pairing mode,${csvCell(session.pairing_mode)}`,
    `Ranking model,${csvCell(session.ranking_model === "games_won" ? "Games won" : "Win points")}`,
    `Matches,${(matches ?? []).length}`,
    `Exported,${new Date().toISOString()}`,
    "",
    header.join(","),
    ...rows.map((r) =>
      [
        r.rank,
        csvCell(names.get(r.player_profile_id)?.public_name ?? "—"),
        r.points,
        r.base_points,
        r.fire_points,
        r.matches_played,
        r.wins,
        r.losses,
        r.games_won,
        r.games_lost,
        r.game_diff,
        r.active_streak,
      ].join(",")
    ),
  ];

  const fileSlug = session.slug.replace(/[^a-z0-9-]/gi, "");
  return new NextResponse(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="session-${fileSlug}.csv"`,
    },
  });
}

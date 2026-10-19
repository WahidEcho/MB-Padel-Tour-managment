import { NextResponse } from "next/server";
import { staffRoute } from "@/lib/guard";
import { privateJson } from "@/lib/mobile/http";
import { eventDay } from "@/lib/matchday/eventDay";
import { lineupActor } from "@/lib/tennis/lineupServer";
import { lineupTemplate, sheetTies, sheetTournaments } from "@/lib/tennis/lineupSheetServer";
import { EVENT_TIME_ZONE } from "@/lib/tennis/ties";

/**
 * The match-day line-up sheet (.xlsx) for the organiser and the master referees:
 * one row per tie of the day (`?day=YYYY-MM-DD`, Cairo; today by default) across the
 * event group's tie events the person reaches, with the players already named, a
 * Squads sheet (order of merit) and short instructions. A court referee: 403.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await staffRoute("score_match", { tournament: id });
  if (!gate.ok) return gate.response;
  const actor = lineupActor(gate.staff);
  if (!actor || actor.kind === "court") return privateJson({ error: "The line-up sheet is for the organiser and the master referees.", code: "not_allowed" }, 403);
  const raw = new URL(request.url).searchParams.get("day") ?? "";
  const day = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : raw === "all" ? null : eventDay(EVENT_TIME_ZONE);
  const ties = await sheetTies(await sheetTournaments(gate.staff, id));
  const file = await lineupTemplate(ties, day);
  return new NextResponse(new Uint8Array(file), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="line-ups-${day ?? "all"}.xlsx"`,
      "Cache-Control": "private, no-store",
    },
  });
}

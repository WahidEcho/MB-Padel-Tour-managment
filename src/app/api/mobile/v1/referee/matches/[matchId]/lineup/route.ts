import { staffRoute } from "@/lib/guard";
import { privateJson } from "@/lib/mobile/http";
import { readJson } from "@/lib/mobile/http";
import { acceptedKeys, applyTieLineups, lineupActor, lineupFromBody, lineupPicker, tieOfMatch } from "@/lib/tennis/lineupServer";
import type { Lineup } from "@/lib/tennis/tieOps";

/**
 * The line-up of the tie a rubber belongs to, for the chair umpire's picker (web
 * console and app), the master referee and the organiser. The match decides the
 * organisation and, for a court code, the court: another court's tie and another
 * organisation's answer 404 like a missing one. Anyone else who scores (a whole-event
 * referee code, a shared referee password): 403.
 *
 * GET: the tie, both squads in order of merit, what is named and the step.
 * POST { lineups: { A?, B? }, accept?: ["A:<key>"], reason? }: both sides checked, then
 * saved (the singles lock once both nations have named theirs). 400 problems, 409
 * warnings to accept (an accepted exception alerts the master referees on duty) or a
 * reason needed for a change after the lock.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  const gate = await staffRoute("score_match", { match: matchId });
  if (!gate.ok) return gate.response;
  const actor = lineupActor(gate.staff);
  if (!actor) return privateJson({ error: "Line-ups are entered by the chair umpire, a master referee or the organiser.", code: "not_allowed" }, 403);
  const picker = await lineupPicker(matchId, actor);
  if (!picker) return privateJson({ error: "This match is not a rubber of a tie.", code: "not_a_rubber" }, 404);
  return privateJson(picker);
}

export async function POST(request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  const gate = await staffRoute("score_match", { match: matchId });
  if (!gate.ok) return gate.response;
  const actor = lineupActor(gate.staff);
  if (!actor) return privateJson({ error: "Line-ups are entered by the chair umpire, a master referee or the organiser.", code: "not_allowed" }, 403);
  const tie = await tieOfMatch(matchId);
  if (!tie) return privateJson({ error: "This match is not a rubber of a tie.", code: "not_a_rubber" }, 404);
  const body = await readJson<{ lineups?: Record<string, unknown>; accept?: unknown; reason?: unknown }>(request);
  const lineups: Partial<Record<"A" | "B", Lineup>> = {};
  for (const s of ["A", "B"] as const) {
    const l = lineupFromBody(body?.lineups?.[s]);
    if (l) lineups[s] = l;
  }
  if (!lineups.A && !lineups.B) return privateJson({ error: "No line-up sent.", code: "bad_request" }, 400);
  const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 300) : "";
  const out = await applyTieLineups({
    actor,
    actorRole: gate.staff.role,
    tournamentId: tie.tournamentId,
    tieId: tie.tieId,
    lineups,
    accept: acceptedKeys(body?.accept),
    reason: reason || null,
    via: actor.kind === "court" ? "court" : "desk",
    lock: true,
  });
  if (!out.ok) {
    const status = out.code === "problems" || out.code === "side_unknown" ? 400 : out.code === "not_here" ? 404 : 409;
    return privateJson({ error: out.message, code: out.code, problems: out.problems, warnings: out.warnings }, status);
  }
  const picker = await lineupPicker(matchId, actor);
  return privateJson({ ok: true, changed: out.changed, locked: out.locked, accepted: out.accepted, alerted: out.alerted, late: out.late, picker });
}

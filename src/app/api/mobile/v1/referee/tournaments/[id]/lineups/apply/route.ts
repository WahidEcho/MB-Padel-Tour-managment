import { staffRoute } from "@/lib/guard";
import { privateJson, readJson } from "@/lib/mobile/http";
import { acceptedKeys, applyTieLineups, lineupActor, lineupFromBody, type SideIssue } from "@/lib/tennis/lineupServer";
import { sheetTournaments } from "@/lib/tennis/lineupSheetServer";
import type { Lineup } from "@/lib/tennis/tieOps";

/**
 * Confirms a previewed line-up sheet: { rows: [{ tieId, tournamentId, lineups: { A?, B? } }],
 * accept: ["A:<key>"], reason? }. Every row is checked first; nothing is saved while
 * any row is refused (400 problems, 409 warnings to accept or a reason needed). Then
 * each tie is saved through setLineup and its singles locked once both nations have
 * named theirs. Rows may only name the tie events the sheet's page reaches (the
 * event group's, scope-checked again here). Organiser and master referees.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await staffRoute("score_match", { tournament: id });
  if (!gate.ok) return gate.response;
  const actor = lineupActor(gate.staff);
  if (!actor || actor.kind === "court") return privateJson({ error: "The line-up sheet is for the organiser and the master referees.", code: "not_allowed" }, 403);
  const body = await readJson<{ rows?: unknown; accept?: unknown; reason?: unknown }>(request);
  const allowed = new Set((await sheetTournaments(gate.staff, id)).map((t) => t.id));
  const raw = Array.isArray(body?.rows) ? body.rows.slice(0, 200) : [];
  if (!raw.length) return privateJson({ error: "No rows to save.", code: "bad_request" }, 400);
  const rows: { tieId: string; tournamentId: string; lineups: Partial<Record<"A" | "B", Lineup>> }[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    const tieId = typeof r?.tieId === "string" ? r.tieId : "";
    const tournamentId = typeof r?.tournamentId === "string" ? r.tournamentId : "";
    // Another organisation's event, or one outside this event group: the same answer as a missing one.
    if (!allowed.has(tournamentId)) return privateJson({ error: "Not found" }, 404);
    const lineups: Partial<Record<"A" | "B", Lineup>> = {};
    for (const s of ["A", "B"] as const) {
      const l = lineupFromBody((r?.lineups as Record<string, unknown> | undefined)?.[s]);
      if (l) lineups[s] = l;
    }
    if (lineups.A || lineups.B) rows.push({ tieId, tournamentId, lineups });
  }
  const accept = acceptedKeys(Array.isArray(body?.accept) ? body.accept.slice(0, 200) : []);
  const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 300) : "";
  const base = { actor, actorRole: gate.staff.role, accept, reason: reason || null, via: "sheet" as const, lock: true };

  // Everything first: one refused row saves nothing.
  const refusals: { tieId: string; code: string; message: string; problems: SideIssue[]; warnings: SideIssue[] }[] = [];
  for (const r of rows) {
    const c = await applyTieLineups({ ...base, ...r, check: true });
    if (!c.ok) refusals.push({ tieId: r.tieId, code: c.code, message: c.message, problems: c.problems, warnings: c.warnings });
  }
  if (refusals.length) {
    const code = refusals.some((r) => r.code === "problems" || r.code === "not_here" || r.code === "side_unknown" || r.code === "under_way")
      ? "problems"
      : refusals.some((r) => r.code === "warnings")
        ? "warnings"
        : "reason";
    return privateJson({ error: refusals.map((r) => r.message).join(" "), code, rows: refusals }, code === "problems" ? 400 : 409);
  }
  let saved = 0;
  let locked = 0;
  let exceptions = 0;
  let alerted = 0;
  const failed: { tieId: string; message: string }[] = [];
  for (const r of rows) {
    const out = await applyTieLineups({ ...base, ...r });
    if (!out.ok) {
      failed.push({ tieId: r.tieId, message: out.message });
      continue;
    }
    if (out.changed) saved++;
    if (out.locked) locked++;
    if (out.accepted.length) exceptions++;
    alerted += out.alerted;
  }
  return privateJson({ ok: failed.length === 0, saved, locked, exceptions, alerted, failed });
}

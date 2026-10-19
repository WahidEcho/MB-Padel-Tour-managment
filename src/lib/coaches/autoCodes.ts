/**
 * Coach codes made by themselves (owner's decision, 20 Oct 2026): when the draw of a tie
 * event is confirmed (its group ties generated: admin Ties page "Generate the group ties",
 * or the Groups page regenerating the group stage), every team of that event gets a coach
 * code. Idempotent: a team with a working code gets nothing (and the database's
 * `coach_codes_one_live_idx` refuses a second unrevoked code even when two clicks race);
 * a team added later gets one the next time the ties are generated, or with Admin → Team
 * coaches → "Create a code for every team" (the same function).
 *
 * Pure part (`teamsNeedingCodes`, rules.ts) is unit tested in coaches.test.ts.
 */
import { db } from "../supabase";
import { audit } from "../audit";
import { zonedToIso } from "../tennis/ties";
import { newCoachCodeRow, type CoachCodeRow, type CoachTeamRow } from "./server";
import { coachCodesNotice, teamsNeedingCodes } from "./rules";

export { coachCodesNotice, teamsNeedingCodes };

/** Without dates on the event, a coach code still ends by itself: two weeks after it is made. */
export const NO_DATES_DAYS = 14;

/** When a team's code stops working: the end of its own event's last day (Cairo), else two weeks from now. */
export function coachCodeExpiry(row: { ends_on: string | null; starts_on: string | null } | undefined, now = Date.now()): string {
  const day = row?.ends_on ?? row?.starts_on ?? null;
  const at = day ? zonedToIso(`${day}T23:59`) : null;
  return at && Date.parse(at) > now ? at : new Date(now + NO_DATES_DAYS * 86_400_000).toISOString();
}

export interface EnsureCoachCodesResult {
  /** Codes made now. */
  created: number;
  /** Teams of the event(s) that now have a working code. */
  covered: number;
  /** Teams (not withdrawn) of the event(s). */
  teams: number;
}

/**
 * A working coach code for every team of these tournaments (all of one organisation).
 * Each insert is on its own so a race with another click only skips that team.
 */
export async function ensureCoachCodes(o: {
  orgId: string;
  tournamentIds: string[];
  createdBy?: string | null;
  createdByRole?: string | null;
  via: "draw" | "button";
}): Promise<EnsureCoachCodesResult> {
  const ids = [...new Set(o.tournamentIds)];
  if (!ids.length) return { created: 0, covered: 0, teams: 0 };
  const [{ data: ts }, { data: teamRows }, { data: codeRows, error: codeErr }] = await Promise.all([
    db().from("tournaments").select("id, name, ends_on, starts_on").eq("organization_id", o.orgId).in("id", ids),
    db().from("teams").select("id, tournament_id, team_name, nation_code, iso2, team_status").in("tournament_id", ids).limit(500),
    db().from("coach_codes").select("id, tournament_id, team_id, label, code_sealed, expires_at, revoked_at, last_used_at, created_at").eq("organization_id", o.orgId).in("tournament_id", ids).limit(1000),
  ]);
  // Before migration 0037 there is no coach_codes table: nothing to make.
  if (codeErr) return { created: 0, covered: 0, teams: 0 };
  const tournaments = new Map(((ts ?? []) as { id: string; name: string; ends_on: string | null; starts_on: string | null }[]).map((t) => [t.id, t]));
  const teams = ((teamRows ?? []) as CoachTeamRow[]).filter((t) => tournaments.has(t.tournament_id));
  const codes = (codeRows ?? []) as CoachCodeRow[];
  const { create, stale } = teamsNeedingCodes(teams, codes);
  const staleOfMissing = codes.filter((c) => stale.includes(c.id) && create.some((t) => t.id === c.team_id)).map((c) => c.id);
  if (staleOfMissing.length) {
    await db().from("coach_codes").update({ revoked_at: new Date().toISOString() }).eq("organization_id", o.orgId).in("id", staleOfMissing).is("revoked_at", null);
  }
  let created = 0;
  for (const t of create) {
    const tr = tournaments.get(t.tournament_id)!;
    const { row } = newCoachCodeRow({ orgId: o.orgId, team: t, eventName: tr.name, expiresAt: coachCodeExpiry(tr), createdBy: o.createdBy ?? null, createdByRole: o.createdByRole ?? null });
    const { data, error } = await db().from("coach_codes").insert({ ...row, organization_id: o.orgId }).select("id, tournament_id, team_id, expires_at").maybeSingle();
    if (error || !data) {
      // 23505: another click made this team's code a moment ago. Anything else: say so.
      if (error && error.code !== "23505" && !/duplicate|unique/i.test(error.message)) throw new Error("Could not create the coach codes. Try again.");
      continue;
    }
    created++;
    const r = data as { id: string; tournament_id: string; team_id: string; expires_at: string | null };
    // Never the code itself: which team, until when, and how it was made.
    await audit({ organization_id: o.orgId, tournament_id: r.tournament_id, actor_role: o.createdByRole ?? null, action: "COACH_CODE_CREATED", entity_type: "coach_code", entity_id: r.id, new_value: { team_id: r.team_id, expires_at: r.expires_at, via: o.via } });
  }
  const live = teams.filter((t) => t.team_status !== "withdrawn");
  return { created, covered: live.length - (create.length - created), teams: live.length };
}

/**
 * The draw of a tie event was confirmed (its group ties generated): codes for its teams.
 * The tournament's own organisation decides; a tournament without one (or that is not a
 * tie event) gets nothing. Never throws: the draw stands even if the codes could not be
 * made (the Team coaches page still has its button).
 */
export async function coachCodesOnDraw(tournamentId: string, actorRole: string | null): Promise<EnsureCoachCodesResult> {
  try {
    const { data } = await db().from("tournaments").select("id, organization_id, format_config").eq("id", tournamentId).maybeSingle();
    const t = data as { id: string; organization_id: string | null; format_config: { ties?: unknown } | null } | null;
    if (!t?.organization_id || !t.format_config?.ties) return { created: 0, covered: 0, teams: 0 };
    return await ensureCoachCodes({ orgId: t.organization_id, tournamentIds: [t.id], createdByRole: actorRole, via: "draw" });
  } catch (e) {
    console.error("coach codes on draw", e);
    return { created: 0, covered: 0, teams: 0 };
  }
}

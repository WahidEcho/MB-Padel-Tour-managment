/**
 * Loads a match's log (matchLog.ts) from its stored score events: who entered each
 * one by name (a referee signed in with their PIN, migration 0035) or by role.
 * Server-only. The caller has already checked the staff principal reaches the match.
 */
import { db } from "../supabase";
import { getMatch, getTeams } from "../data";
import { buildMatchLog, type LogEntry, type LogEventRow } from "./matchLog";

const ROLE_NAMES: Record<string, string> = { admin: "Admin", manager: "Manager", referee: "Referee", operator: "Operator" };

export interface MatchLogView {
  matchId: string;
  sides: { A: string; B: string };
  entries: LogEntry[];
}

export async function loadMatchLog(matchId: string): Promise<MatchLogView | null> {
  const match = await getMatch(matchId);
  if (!match) return null;
  const [{ data }, teams] = await Promise.all([
    db()
      .from("score_events")
      .select("event_number, event_type, team_id, note, previous_state_json, new_state_json, created_at_client, created_at_server, created_by, created_by_role, sync_status")
      .eq("match_id", matchId)
      .order("event_number", { ascending: true })
      .limit(5000),
    getTeams(match.tournament_id),
  ]);
  type Row = {
    event_number: number;
    event_type: string;
    team_id: string | null;
    note: string | null;
    previous_state_json: unknown;
    new_state_json: unknown;
    created_at_client: string | null;
    created_at_server: string | null;
    created_by: string | null;
    created_by_role: string | null;
    sync_status: string | null;
  };
  const rows = (data ?? []) as Row[];
  const refIds = [...new Set(rows.map((r) => r.created_by).filter((v): v is string => Boolean(v?.startsWith("referee:"))).map((v) => v.slice(8)))];
  const names = new Map<string, string>();
  if (refIds.length) {
    const { data: refs } = await db().from("referees").select("id, name").in("id", refIds);
    for (const r of (refs ?? []) as { id: string; name: string }[]) names.set(r.id, r.name);
  }
  const who = (r: Row) => {
    const ref = r.created_by?.startsWith("referee:") ? names.get(r.created_by.slice(8)) : null;
    const role = ROLE_NAMES[r.created_by_role ?? ""] ?? r.created_by_role ?? null;
    return ref ? `${ref}${role ? ` (${role.toLowerCase()})` : ""}` : role;
  };
  const parse = (note: string | null): Record<string, unknown> | null => {
    if (!note) return null;
    try {
      const v = JSON.parse(note) as unknown;
      return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const logRows: LogEventRow[] = rows.map((r) => ({
    event_number: r.event_number,
    event_type: r.event_type,
    team_id: r.team_id,
    payload: parse(r.note),
    previous_state: r.previous_state_json,
    new_state: r.new_state_json,
    at: r.created_at_client ?? r.created_at_server,
    by: who(r),
    superseded: r.sync_status === "superseded",
  }));
  const name = (id: string | null) => teams.find((t) => t.id === id)?.team_name ?? "—";
  const sides = { A: name(match.team_a_id), B: name(match.team_b_id) };
  return {
    matchId,
    sides,
    entries: buildMatchLog(logRows, { A: { id: match.team_a_id, name: sides.A }, B: { id: match.team_b_id, name: sides.B } }),
  };
}
